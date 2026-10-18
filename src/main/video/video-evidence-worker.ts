import { parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { opendir, stat } from 'node:fs/promises'
import { join, relative, basename } from 'node:path'

/** Bounded, sequential asset hashing stays off Electron's main thread. */
async function snapshot(folder: string) {
  const files: { path: string; sha256: string; bytes: number }[] = []
  let bytes = 0,
    entries = 0
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 12) throw new Error('Composition asset nesting exceeds 12 levels')
    const handle = await opendir(directory)
    for await (const entry of handle) {
      if (++entries > 2048) throw new Error('Composition evidence exceeds 2048 entries')
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error('Composition evidence cannot bind symbolic-link assets')
      if (entry.isDirectory()) {
        await walk(path, depth + 1)
        continue
      }
      if (!entry.isFile()) throw new Error('Composition evidence requires ordinary files')
      if (files.length >= 512) throw new Error('Composition evidence exceeds 512 files')
      const before = await stat(path)
      bytes += before.size
      if (bytes > 512 * 1024 * 1024)
        throw new Error('Composition evidence exceeds 512 MiB of assets')
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 }))
        digest.update(chunk)
      const after = await stat(path)
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
        throw new Error('An asset changed while it was being hashed')
      files.push({
        path: relative(folder, path).replaceAll('\\', '/'),
        sha256: digest.digest('hex'),
        bytes: before.size
      })
    }
  }
  await walk(folder, 0)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files, bytes }
}
async function outputDigest(file: string) {
  const before = await stat(file)
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(file, { highWaterMark: 256 * 1024 }))
    digest.update(chunk)
  const after = await stat(file)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('Export changed during hashing')
  const sha256 = digest.digest('hex')
  return {
    sha256,
    bytes: before.size,
    files: [{ path: basename(file), sha256, bytes: before.size }]
  }
}
void (
  typeof workerData === 'string'
    ? snapshot(workerData)
    : outputDigest((workerData as { file: string }).file)
)
  .then((result) => parentPort?.postMessage({ result }))
  .catch((error: unknown) =>
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
  )
