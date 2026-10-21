/** Restore executable bits missing from node-pty's installed macOS helpers. */
import { chmod, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { Logger } from '../src/main/system/logger'

if (process.platform === 'darwin') {
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve('node-pty/package.json'))
  const prebuilds = join(packageRoot, 'prebuilds')
  const directories = [join(packageRoot, 'build/Release'), join(packageRoot, 'build/Debug')]
  // Prepare both architectures so cross-architecture packages retain the fix.
  for (const entry of await readdir(prebuilds, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('darwin-')) {
      directories.push(join(prebuilds, entry.name))
    }
  }
  for (const directory of directories) {
    const helper = join(directory, 'spawn-helper')
    let metadata
    try {
      metadata = await stat(helper)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    if (metadata.isFile() && (metadata.mode & 0o111) !== 0o111) {
      await chmod(helper, metadata.mode | 0o111)
      Logger.dev(`[ensure-pty-helper] Restored executable permissions: ${helper}`)
    }
  }
}
