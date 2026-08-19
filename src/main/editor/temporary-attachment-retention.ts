import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Stage an attached source file into an app-owned scratch directory. Every
 * attachment registered with a scope is copied here — including sources from
 * stable folders like ~/Downloads or the Desktop — so the file is project-owned,
 * outlives the renderer gesture, and exposes a readable path the harness and the
 * image descriptor can rely on. Copies are published atomically.
 */
export async function retainTemporaryAttachment(
  sourcePath: string,
  destinationDirectory: string
): Promise<string> {
  const canonicalSource = await realpath(sourcePath)
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