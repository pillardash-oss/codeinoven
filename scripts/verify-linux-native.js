import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Ubuntu 22.04 is the Linux release baseline. A successful load on a newer
// build host does not prove that the artifact can run on supported desktops.
export function verifyLinuxNative(directory) {
  let terminalFound = false
  function visit(root) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const file = join(root, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.name.endsWith('.node')) {
        const result = spawnSync('readelf', ['--version-info', file], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C' }
        })
        // Packages also carry Windows and macOS prebuilds. Only inspect ELF.
        if (result.status !== 0 && result.stderr?.includes('Not an ELF file')) continue
        if (result.error || result.status !== 0) {
          throw new Error(
            `Cannot inspect Linux native dependency ${file}: ${result.error?.message ?? result.stderr}`
          )
        }
        if (entry.name === 'pty.node') terminalFound = true
        for (const match of result.stdout.matchAll(/\bGLIBC_(\d+)\.(\d+)\b/g)) {
          if (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) > 35)) {
            throw new Error(
              `${file} requires ${match[0]}; Linux releases must support glibc 2.35. Rebuild native dependencies on Ubuntu 22.04 instead of reusing binaries from a newer host.`
            )
          }
        }
      }
    }
  }
  visit(directory)
  if (!terminalFound) throw new Error('Packaged Linux terminal dependency pty.node is missing')
}
