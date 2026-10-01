import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  readlink,
  symlink,
  rename
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { OvenFile, OvenWorkspaceRequest, OvenWorkspaceResult } from '../../../lib/ovens'

const CHUNK = 128 * 1024

export function workspaceRoot(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/u.test(value))
    throw new Error('Invalid workspace path.')
  const path = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
  if (!isAbsolute(path) || path === sep)
    throw new Error('Choose an absolute workspace directory, or ~/directory.')
  return resolve(path)
}

async function workspacePath(root: string, value: unknown, create = false): Promise<string> {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || isAbsolute(value))
    throw new Error('Choose a relative workspace path.')
  const path = resolve(root, value || '.')
  const inside = relative(root, path)
  if (inside === '..' || inside.startsWith(`..${sep}`))
    throw new Error('Path leaves the workspace.')
  const canonicalRoot = await realpath(root)
  let ancestor = create ? dirname(path) : path
  for (;;) {
    try {
      const canonical = await realpath(ancestor)
      const distance = relative(canonicalRoot, canonical)
      if (distance === '..' || distance.startsWith(`..${sep}`))
        throw new Error('A symbolic link leaves the workspace.')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (ancestor === root) throw error
      ancestor = dirname(ancestor)
    }
  }
  return path
}

async function fileInfo(root: string, path: string): Promise<OvenFile> {
  const info = await lstat(path)
  return {
    path: relative(root, path).split(sep).join('/'),
    kind: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
    size: info.size,
    modifiedAt: info.mtimeMs,
    mode: info.mode & 0o777,
    ...(info.isSymbolicLink() ? { target: await readlink(path) } : {})
  }
}

async function command(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    let text = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('Remote Git operation timed out.'))
    }, 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      if (Buffer.byteLength(text) > 512 * 1024) {
        child.kill('SIGTERM')
        reject(new Error('Git output is too large. Narrow the request.'))
      }
    })
    child.stderr.resume()
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolveResult(text)
      else reject(new Error(`Remote Git operation failed (${code}).`))
    })
  })
}

/** Bounded asynchronous filesystem and Git requests executed on the selected machine. */
export async function ovenWorkspace(raw: unknown): Promise<OvenWorkspaceResult> {
  if (!raw || typeof raw !== 'object') throw new Error('Workspace request required.')
  const input = raw as OvenWorkspaceRequest
  const root = workspaceRoot(input.root)
  if (input.operation === 'ensure') {
    await mkdir(root, { recursive: true, mode: 0o700 })
    return { root: await realpath(root) }
  }
  if (input.operation === 'reserve') {
    await mkdir(dirname(root), { recursive: true, mode: 0o700 })
    await mkdir(root, { mode: 0o700 })
    return { root: await realpath(root) }
  }
  if (input.operation === 'clone') {
    if (
      typeof input.url !== 'string' ||
      input.url.length > 4096 ||
      !/^(?:https:\/\/|ssh:\/\/|git@)[^\s\0]+$/u.test(input.url)
    )
      throw new Error('Use an HTTPS or SSH Git URL.')
    await mkdir(dirname(root), { recursive: true, mode: 0o700 })
    await command('git', ['clone', '--', input.url, root])
    return { root }
  }
  if (input.operation === 'git') {
    const args =
      input.action === 'status'
        ? ['status', '--short', '--branch']
        : input.action === 'diff'
          ? ['diff', '--no-ext-diff', '--no-textconv', '--']
          : input.action === 'log'
            ? ['log', '-20', '--oneline']
            : null
    if (!args) throw new Error('Unsupported Git operation.')
    return { root, text: await command('git', args, root) }
  }
  const path = await workspacePath(
    root,
    input.path,
    ['write', 'mkdir', 'symlink', 'replace'].includes(input.operation)
  )
  if (input.operation === 'replace') {
    if (!Number.isInteger(input.mode) || input.mode < 0 || input.mode > 0o777)
      throw new Error('Invalid file mode.')
    if (input.expectedData !== undefined) {
      if (typeof input.expectedData !== 'string' || input.expectedData.length > CHUNK * 1.4)
        throw new Error('Invalid editor original.')
      const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const buffer = Buffer.alloc(CHUNK + 1)
        const { bytesRead } = await current.read(buffer, 0, buffer.length, 0)
        if (
          bytesRead > CHUNK ||
          !buffer.subarray(0, bytesRead).equals(Buffer.from(input.expectedData, 'base64'))
        )
          throw new Error('The file changed on the Oven. Reload it before saving.')
      } finally {
        await current.close()
      }
    }
    const staged = await workspacePath(root, input.staged)
    await chmod(staged, input.mode)
    await rename(staged, path)
    return { root }
  }
  if (input.operation === 'stat') return { root, file: await fileInfo(root, path) }
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
    for (const name of entries) files.push(await fileInfo(root, join(path, name)))
    return { root, files, ...(entries.length === 128 ? { after: entries.at(-1) } : {}) }
  }
  if (input.operation === 'mkdir') {
    await mkdir(path, { recursive: true, mode: 0o700 })
    return { root }
  }
  if (input.operation === 'symlink') {
    if (typeof input.target !== 'string' || isAbsolute(input.target) || input.target.includes('\0'))
      throw new Error('Transfer only relative symbolic links.')
    const target = resolve(dirname(path), input.target)
    if (relative(root, target).startsWith('..'))
      throw new Error('Symbolic link leaves the workspace.')
    await symlink(input.target, path)
    return { root }
  }
  if (input.operation !== 'read' && input.operation !== 'write')
    throw new Error('Unsupported workspace operation.')
  if (!Number.isSafeInteger(input.offset) || input.offset < 0)
    throw new Error('Invalid file offset.')
  const file = await open(
    path,
    input.operation === 'read'
      ? constants.O_RDONLY | constants.O_NOFOLLOW
      : constants.O_RDWR |
          constants.O_NOFOLLOW |
          (input.exclusive ? constants.O_CREAT | constants.O_EXCL : 0),
    0o600
  )
  try {
    if (input.operation === 'read') {
      const buffer = Buffer.alloc(CHUNK)
      const { bytesRead } = await file.read(buffer, 0, CHUNK, input.offset)
      return {
        root,
        data: buffer.subarray(0, bytesRead).toString('base64'),
        size: (await file.stat()).size
      }
    }
    if (
      typeof input.data !== 'string' ||
      input.data.length > CHUNK * 1.4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(input.data)
    )
      throw new Error('Invalid file data.')
    const buffer = Buffer.from(input.data, 'base64')
    let written = 0
    while (written < buffer.length) {
      const result = await file.write(
        buffer,
        written,
        buffer.length - written,
        input.offset + written
      )
      if (!result.bytesWritten) throw new Error('File write made no progress.')
      written += result.bytesWritten
    }
    if (input.mode !== undefined) {
      if (!Number.isInteger(input.mode) || input.mode < 0 || input.mode > 0o777)
        throw new Error('Invalid file mode.')
      await chmod(path, input.mode)
    }
    return { root }
  } finally {
    await file.close()
  }
}
