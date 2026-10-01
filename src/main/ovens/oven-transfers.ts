import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, readlink, realpath, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  OvenFile,
  OvenTransferInput,
  OvenTransferReview,
  OvenWorkspaceRequest,
  OvenWorkspaceResult
} from '../../lib/ovens'
import { LOCAL_OVEN_ID } from '../../lib/ovens'
import type { OvenService } from './oven-service'

interface Review {
  summary: OvenTransferReview
  manifest: OvenFile[]
}

/** Explicit, non-overwriting transfers. At most one file chunk is in memory. */
export class OvenTransfers {
  private readonly reviews = new Map<string, Review>()
  private active = false
  constructor(private readonly service: OvenService) {}

  async workspace(ovenId: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult> {
    if (ovenId !== LOCAL_OVEN_ID) return this.service.workspace(ovenId, input)
    const root = input.root
    if (!isAbsolute(root) || root === sep || /[\0\r\n]/u.test(root))
      throw new Error('Use an absolute workspace directory.')
    if (input.operation === 'reserve') {
      await mkdir(dirname(root), { recursive: true })
      await mkdir(root, { mode: 0o700 })
      return { root }
    }
    if (!('path' in input)) throw new Error('This operation requires a remote Oven.')
    const canonicalRoot = await realpath(root)
    const path = resolve(root, input.path || '.')
    const distance = relative(root, path)
    if (isAbsolute(input.path) || distance === '..' || distance.startsWith(`..${sep}`))
      throw new Error('Path leaves the workspace.')
    let ancestor = ['write', 'mkdir', 'symlink'].includes(input.operation) ? dirname(path) : path
    // lstat is allowed on a link without following it; transfers preserve relative links.
    if (input.operation === 'stat' && path !== root) ancestor = dirname(path)
    while (ancestor !== root) {
      try {
        const canonical = await realpath(ancestor)
        const escape = relative(canonicalRoot, canonical)
        if (escape === '..' || escape.startsWith(`..${sep}`))
          throw new Error('A symbolic link leaves the workspace.')
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        ancestor = dirname(ancestor)
      }
    }
    const info = async (filePath: string): Promise<OvenFile> => {
      const entry = await lstat(filePath)
      return {
        path: relative(root, filePath).split(sep).join('/'),
        kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        size: entry.size,
        modifiedAt: entry.mtimeMs,
        mode: entry.mode & 0o777,
        ...(entry.isSymbolicLink() ? { target: await readlink(filePath) } : {})
      }
    }
    if (input.operation === 'stat') return { root, file: await info(path) }
    if (input.operation === 'list') {
      const entries: string[] = []
      for await (const entry of await opendir(path)) {
        if (input.after && entry.name.localeCompare(input.after) <= 0) continue
        const index = entries.findIndex((name) => entry.name.localeCompare(name) < 0)
        if (index < 0) {
          if (entries.length < 128) entries.push(entry.name)
        } else entries.splice(index, 0, entry.name)
        if (entries.length > 128) entries.pop()
      }
      const files: OvenFile[] = []
      for (const name of entries) files.push(await info(resolve(path, name)))
      return { root, files, ...(entries.length === 128 ? { after: entries.at(-1) } : {}) }
    }
    if (input.operation === 'mkdir') {
      await mkdir(path, { recursive: true })
      return { root }
    }
    if (input.operation === 'symlink') {
      if (
        isAbsolute(input.target) ||
        relative(root, resolve(dirname(path), input.target)).startsWith('..')
      )
        throw new Error('Symbolic link leaves the workspace.')
      await symlink(input.target, path)
      return { root }
    }
    if (input.operation !== 'read' && input.operation !== 'write')
      throw new Error('Unsupported transfer operation.')
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new Error('Invalid offset.')
    const file = await open(
      path,
      input.operation === 'read'
        ? constants.O_RDONLY | constants.O_NOFOLLOW
        : constants.O_RDWR |
            constants.O_NOFOLLOW |
            (input.exclusive ? constants.O_CREAT | constants.O_EXCL : 0),
      input.operation === 'write' ? (input.mode ?? 0o600) : 0o600
    )
    try {
      if (input.operation === 'read') {
        const buffer = Buffer.alloc(128 * 1024)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, input.offset)
        return {
          root,
          data: buffer.subarray(0, bytesRead).toString('base64'),
          size: (await file.stat()).size
        }
      }
      const buffer = Buffer.from(input.data, 'base64')
      if (buffer.length > 128 * 1024) throw new Error('Transfer chunk too large.')
      await file.write(buffer, 0, buffer.length, input.offset)
      return { root }
    } finally {
      await file.close()
    }
  }

  async review(input: OvenTransferInput): Promise<OvenTransferReview> {
    if (input.sourceOvenId === input.targetOvenId && input.sourceRoot === input.targetRoot)
      throw new Error('Choose a different destination.')
    if (this.reviews.size >= 8) this.reviews.clear()
    const manifest: OvenFile[] = []
    const directories = ['']
    let bytes = 0
    for (let index = 0; index < directories.length; index++) {
      let after: string | undefined
      do {
        const page = await this.workspace(input.sourceOvenId, {
          operation: 'list',
          root: input.sourceRoot,
          path: directories[index],
          after
        })
        for (const file of page.files ?? []) {
          if (manifest.length >= 20_000)
            throw new Error('Transfer exceeds 20,000 entries. Choose a smaller directory.')
          if (file.path === '.cio/tmp' || file.path.startsWith('.cio/tmp/')) continue
          if (
            file.kind === 'symlink' &&
            (!file.target ||
              isAbsolute(file.target) ||
              relative('.', resolve(dirname(file.path), file.target)).startsWith('..'))
          )
            throw new Error(
              'Transfer contains an external symbolic link. Choose a directory without external links.'
            )
          manifest.push(file)
          if (file.kind === 'directory') directories.push(file.path)
          else if (file.kind === 'file') bytes += file.size
          if (bytes > 20 * 1024 ** 3)
            throw new Error('Transfer exceeds 20 GiB. Choose a smaller directory.')
        }
        after = page.after
      } while (after)
    }
    // Destination must not exist. Confirmation never grants permission to overwrite work.
    let exists = false
    try {
      await this.workspace(input.targetOvenId, {
        operation: 'stat',
        root: input.targetRoot,
        path: ''
      })
      exists = true
    } catch (error) {
      if (
        input.targetOvenId === LOCAL_OVEN_ID &&
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      )
        throw error
      if (
        input.targetOvenId !== LOCAL_OVEN_ID &&
        !(error instanceof Error && error.message.includes('ENOENT'))
      )
        throw error
    }
    if (exists)
      throw new Error(
        'The destination already exists. Choose a new directory to preserve its files.'
      )
    const summary = {
      ...input,
      id: randomUUID(),
      files: manifest.filter((entry) => entry.kind !== 'directory').length,
      bytes,
      expiresAt: Date.now() + 10 * 60_000
    }
    this.reviews.set(summary.id, { summary, manifest })
    return summary
  }

  async execute(id: string): Promise<OvenTransferReview> {
    const review = this.reviews.get(id)
    if (!review || review.summary.expiresAt < Date.now())
      throw new Error('Transfer review expired. Review it again.')
    if (this.active) throw new Error('A transfer is already running.')
    this.active = true
    this.reviews.delete(id)
    const input = review.summary
    try {
      await this.workspace(input.targetOvenId, { operation: 'reserve', root: input.targetRoot })
      for (const entry of review.manifest) {
        const destination = { root: input.targetRoot, path: entry.path }
        if (entry.kind === 'directory') {
          await this.workspace(input.targetOvenId, { ...destination, operation: 'mkdir' })
          continue
        }
        if (entry.kind === 'symlink') {
          await this.workspace(input.targetOvenId, {
            ...destination,
            operation: 'symlink',
            target: entry.target!
          })
          continue
        }
        const current = await this.workspace(input.sourceOvenId, {
          operation: 'stat',
          root: input.sourceRoot,
          path: entry.path
        })
        if (current.file?.size !== entry.size || current.file.modifiedAt !== entry.modifiedAt)
          throw new Error(
            `Source changed since review: ${entry.path}. Destination contains a partial transfer.`
          )
        let offset = 0
        do {
          const chunk = await this.workspace(input.sourceOvenId, {
            operation: 'read',
            root: input.sourceRoot,
            path: entry.path,
            offset
          })
          if (chunk.size !== entry.size)
            throw new Error(`Source changed during transfer: ${entry.path}.`)
          await this.workspace(input.targetOvenId, {
            ...destination,
            operation: 'write',
            offset,
            data: chunk.data ?? '',
            exclusive: offset === 0,
            mode: entry.mode
          })
          const length = Buffer.byteLength(chunk.data ?? '', 'base64')
          offset += length
          if (!length) break
        } while (offset < entry.size)
        const final = await this.workspace(input.sourceOvenId, {
          operation: 'stat',
          root: input.sourceRoot,
          path: entry.path
        })
        if (
          offset !== entry.size ||
          final.file?.size !== entry.size ||
          final.file.modifiedAt !== entry.modifiedAt
        )
          throw new Error(
            `Source changed during transfer: ${entry.path}. Destination contains a partial transfer.`
          )
      }
      return input
    } finally {
      this.active = false
    }
  }
}
