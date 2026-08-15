import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix, win32 } from 'node:path'
import { randomUUID } from 'node:crypto'

interface TemporaryPathContext {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  osTemporaryDirectory?: string
}

function normalizedPath(path: string, platform: NodeJS.Platform): string {
  const pathApi = platform === 'win32' ? win32 : posix
  const normalized = pathApi.resolve(path)
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function isWithinDirectory(path: string, root: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === 'win32' ? win32 : posix
  const relativePath = pathApi.relative(
    normalizedPath(root, platform),
    normalizedPath(path, platform)
  )
  return (
    relativePath === '' || (!relativePath.startsWith(`..${pathApi.sep}`) && relativePath !== '..')
  )
}

function temporaryRoots(context: TemporaryPathContext): string[] {
  const platform = context.platform ?? process.platform
  const environment = context.environment ?? process.env
  const roots = [
    context.osTemporaryDirectory ?? tmpdir(),
    environment['TMPDIR'],
    environment['TMP'],
    environment['TEMP']
  ]

  if (platform === 'win32') {
    if (environment['LOCALAPPDATA']) roots.push(win32.join(environment['LOCALAPPDATA'], 'Temp'))
    if (environment['SystemRoot']) roots.push(win32.join(environment['SystemRoot'], 'Temp'))
  } else {
    roots.push('/tmp', '/var/tmp')
    if (platform === 'linux' && environment['XDG_RUNTIME_DIR']) {
      roots.push(environment['XDG_RUNTIME_DIR'])
    }
    if (platform === 'darwin') roots.push('/private/tmp', '/private/var/tmp')
  }

  return [...new Set(roots.filter((root): root is string => Boolean(root?.trim())))]
}

/**
 * Whether a native path lives under an operating-system temporary directory.
 * The macOS fallback covers the per-user `/var/folders/.../T` convention even
 * when an inherited TMPDIR value is unavailable or uses the `/private` alias.
 */
export function isTemporaryAttachmentPath(
  path: string,
  context: TemporaryPathContext = {}
): boolean {
  const platform = context.platform ?? process.platform
  if (temporaryRoots(context).some((root) => isWithinDirectory(path, root, platform))) return true
  if (platform !== 'darwin') return false

  const normalized = normalizedPath(path, platform).replace(/^\/private(?=\/var\/)/u, '')
  return /^\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/u.test(normalized)
}

/**
 * Copy an ephemeral attachment into an app-owned scratch directory. Stable
 * source paths pass through unchanged; copied files are published atomically.
 */
export async function retainTemporaryAttachment(
  sourcePath: string,
  destinationDirectory: string
): Promise<string> {
  const canonicalSource = await realpath(sourcePath)
  if (!isTemporaryAttachmentPath(sourcePath) && !isTemporaryAttachmentPath(canonicalSource)) {
    return sourcePath
  }

  const sourceInfo = await stat(canonicalSource)
  if (!sourceInfo.isFile()) throw new TypeError('Attachment source must be a file')

  const retainedDirectory = join(destinationDirectory, randomUUID())
  await mkdir(retainedDirectory, { recursive: true })
  const retainedPath = join(retainedDirectory, basename(canonicalSource))
  const stagingPath = join(
    retainedDirectory,
    `.${basename(retainedPath)}.${process.pid}.${randomUUID()}.tmp`
  )

  try {
    await copyFile(canonicalSource, stagingPath, constants.COPYFILE_EXCL)
    await chmod(stagingPath, 0o600)
    await rename(stagingPath, retainedPath)
    return retainedPath
  } catch (error) {
    await rm(stagingPath, { force: true }).catch(() => undefined)
    throw error
  }
}
