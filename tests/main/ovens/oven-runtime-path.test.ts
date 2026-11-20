import { describe, expect, it } from 'vitest'
import {
  runtimeBinDirs,
  runtimePath,
  type RuntimePathProbe
} from '../../../src/main/ovens/remote/oven-runtime-path'

/** A probe over a fixed set of directories and version entries. */
function probe(dirs: readonly string[], versions: readonly string[] = []): RuntimePathProbe {
  const present = new Set(dirs)
  return {
    exists: (path) => present.has(path),
    readDir: (path) => (path.endsWith('/.nvm/versions/node') ? [...versions] : [])
  }
}

const home = '/home/azureuser'

describe('oven runtime PATH', () => {
  // These paths belong to a POSIX Oven, so their spelling must not depend on the
  // host that composes them: on a Windows runner `join` returned `\\home\\...`.
  // The platform is stated because it is the Oven's, not the test host's: the
  // default is `process.platform`, which on a Windows runner is the Windows Oven
  // branch and legitimately composes Windows paths.
  it('puts the harness shims first and the newest nvm runtime next', () => {
    const dirs = runtimeBinDirs({
      home,
      platform: 'linux',
      npmPrefix: '.config/pillardash/codeinoven/ovens/harnesses/npm',
      basePath: '/usr/bin:/bin',
      probe: probe(
        [
          '/home/azureuser/.config/pillardash/codeinoven/ovens/harnesses/npm/bin',
          '/home/azureuser/.nvm/versions/node/v18.20.4/bin',
          '/home/azureuser/.nvm/versions/node/v26.13.1/bin',
          '/home/azureuser/.nvm/versions/node/v9.11.2/bin'
        ],
        ['v18.20.4', 'v9.11.2', 'v26.13.1']
      )
    })
    expect(dirs).toEqual([
      '/home/azureuser/.config/pillardash/codeinoven/ovens/harnesses/npm/bin',
      '/home/azureuser/.nvm/versions/node/v26.13.1/bin',
      '/home/azureuser/.nvm/versions/node/v18.20.4/bin',
      '/home/azureuser/.nvm/versions/node/v9.11.2/bin'
    ])
  })

  it('skips directories that are not there and ignores non-version entries', () => {
    const dirs = runtimeBinDirs({
      home,
      platform: 'linux',
      npmPrefix: 'prefix',
      basePath: '/usr/bin',
      probe: probe(
        ['/home/azureuser/prefix/bin', '/home/azureuser/.local/bin'],
        ['v22.1.0', 'default', 'v22.2.0']
      )
    })
    expect(dirs).toEqual(['/home/azureuser/prefix/bin', '/home/azureuser/.local/bin'])
  })

  it('keeps the caller PATH last and never repeats a directory', () => {
    const path = runtimePath({
      home,
      platform: 'linux',
      npmPrefix: 'prefix',
      basePath: '/home/azureuser/prefix/bin:/usr/local/bin:/usr/bin:/bin',
      probe: probe(['/home/azureuser/prefix/bin', '/usr/local/bin'])
    })
    expect(path).toBe('/home/azureuser/prefix/bin:/usr/local/bin:/usr/bin:/bin')
  })

  it('leaves Windows alone: no POSIX runtime directories are invented', () => {
    const dirs = runtimeBinDirs({
      home: 'C:\\Users\\oven',
      npmPrefix: 'prefix',
      basePath: 'C:\\Windows',
      probe: probe([
        'C:\\Users\\oven\\prefix\\bin',
        'C:\\Users\\oven\\.nvm\\versions\\node\\v22.0.0\\bin'
      ]),
      platform: 'win32'
    })
    expect(dirs).toEqual(['C:\\Users\\oven\\prefix\\bin'])
  })
})
