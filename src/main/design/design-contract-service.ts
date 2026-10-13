import {
  lstat,
  opendir,
  readFile,
  realpath,
  rename,
  writeFile,
  unlink,
  mkdir,
  link
} from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DESIGN_CONTRACT_DIRECTORIES, isDesignContractName } from '../../lib/design/design-contract'
import { formatDateTime } from '../../lib/date-time-format'

export interface DesignContractFile {
  path: string
  content: string
}

export async function readDesignContracts(root: string): Promise<DesignContractFile[]> {
  const canonicalRoot = await realpath(root)
  const results: DesignContractFile[] = []
  for (const directory of DESIGN_CONTRACT_DIRECTORIES) {
    const folder = join(root, directory)
    const canonical = await realpath(folder).catch(() => null)
    if (!canonical) continue
    const within = relative(canonicalRoot, canonical)
    if (within.startsWith('..') || isAbsolute(within)) continue
    const entries = await opendir(folder).catch(() => null)
    if (!entries) continue
    const found: DesignContractFile[] = []
    for await (const entry of entries) {
      if (!isDesignContractName(entry.name)) continue
      if (!entry.isFile()) throw new Error(`Design contract ${entry.name} must be a regular file`)
      const path = join(directory, entry.name).replaceAll('\\', '/')
      const info = await lstat(join(root, path))
      if (info.size > 128 * 1024) throw new Error(`Design contract ${path} exceeds 128 KiB`)
      found.push({ path, content: await readFile(join(root, path), 'utf8') })
    }
    results.push(...found.sort((a, b) => a.path.localeCompare(b.path)))
  }
  return results
}

/** Prepare the replacement before preserving originals. Roll back a failed publish. */
export async function writeDesignContract(
  root: string,
  markdown: unknown
): Promise<{ path: string; backups: string[]; changedAt: string }> {
  const canonicalRoot = await realpath(root)
  if (writing.has(canonicalRoot))
    throw new Error('Design contract generation is already publishing')
  writing.add(canonicalRoot)
  try {
    return await publishDesignContract(canonicalRoot, markdown)
  } finally {
    writing.delete(canonicalRoot)
  }
}

const writing = new Set<string>()

async function publishDesignContract(
  root: string,
  markdown: unknown
): Promise<{ path: string; backups: string[]; changedAt: string }> {
  if (
    typeof markdown !== 'string' ||
    !markdown.trim() ||
    Buffer.byteLength(markdown) > 128 * 1024
  ) {
    throw new Error('markdown must be nonempty and at most 128 KiB')
  }
  const existing = await readDesignContracts(root)
  const stamp = new Date()
  const suffix = `${stamp.toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
  const destination = join(root, 'DESIGN.md')
  const scratch = join(root, '.cio', 'tmp')
  await mkdir(scratch, { recursive: true })
  const temporary = join(scratch, `design-contract-${randomUUID()}.md`)
  const backups: string[] = []
  await writeFile(temporary, markdown.trimEnd() + '\n', { flag: 'wx' })
  try {
    for (const contract of existing) {
      const backup = `${contract.path}-old-${suffix}`
      await rename(join(root, contract.path), join(root, backup))
      backups.push(backup)
    }
    await link(temporary, destination)
    await unlink(temporary).catch(() => {})
  } catch (error) {
    for (let i = backups.length - 1; i >= 0; i--) {
      // Never overwrite a file another editor created while publishing.
      await link(join(root, backups[i]!), join(root, existing[i]!.path))
        .then(() => unlink(join(root, backups[i]!)))
        .catch(() => {})
    }
    await unlink(temporary).catch(() => {})
    throw error
  }
  return { path: 'DESIGN.md', backups, changedAt: formatDateTime(stamp.getTime()) }
}
