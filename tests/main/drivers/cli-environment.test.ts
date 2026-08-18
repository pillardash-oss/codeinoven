import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildHarnessEnvironment,
  OWNED_PROCESS_MARKER
} from '../../../src/main/drivers/cli-environment'

let tmp: string | undefined

async function makeNvmHome(versions: string[], alias?: string): Promise<string> {
  tmp = await mkdtemp(join(tmpdir(), 'cio-nvm-'))
  const versionRoot = join(tmp, '.nvm', 'versions', 'node')
  for (const version of versions) {
    await mkdir(join(versionRoot, version, 'bin'), { recursive: true })
  }
  if (alias) {
    await mkdir(join(tmp, '.nvm', 'alias'), { recursive: true })
    await writeFile(join(tmp, '.nvm', 'alias', 'default'), alias, 'utf8')
  }
  return tmp
}

afterEach(async () => {
  if (tmp) {
    await rm(tmp, { recursive: true, force: true })
    tmp = undefined
  }
})

describe.skipIf(process.platform === 'win32')('buildHarnessEnvironment — unix nvm', () => {
  it('puts the user nvm default major version first in PATH', async () => {
    const home = await makeNvmHome(['v19.0.1', 'v24.18.0', 'v22.19.0'], '24')
    const env = buildHarnessEnvironment({ HOME: home, PATH: '/usr/bin' }, 'darwin')
    const first = env['PATH']?.split(':')[0]
    expect(first).toBe(join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin'))
  })

  it('resolves a full version alias to that exact version', async () => {
    const home = await makeNvmHome(['v19.0.1', 'v24.18.0'], 'v22.19.0')
    // v22.19.0 is not installed, so fall back to newest installed.
    const env = buildHarnessEnvironment({ HOME: home }, 'darwin')
    expect(env['PATH']?.split(':')[0]).toBe(
      join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin')
    )
  })

  it('sorts versioned bins newest-first when no default alias is set', async () => {
    const home = await makeNvmHome(['v19.0.1', 'v24.18.0', 'v22.19.0'])
    const env = buildHarnessEnvironment({ HOME: home }, 'darwin')
    const bins = env['PATH']?.split(':').filter((p) => p.includes('/versions/node/'))
    expect(bins).toEqual([
      join(home, '.nvm', 'versions', 'node', 'v24.18.0', 'bin'),
      join(home, '.nvm', 'versions', 'node', 'v22.19.0', 'bin'),
      join(home, '.nvm', 'versions', 'node', 'v19.0.1', 'bin')
    ])
  })
})

it('sets the owned process marker', () => {
  const env = buildHarnessEnvironment({}, process.platform)
  expect(env[OWNED_PROCESS_MARKER]).toBe('1')
})

describe('buildHarnessEnvironment — windows (nvm-windows)', () => {
  it('uses a ; PATH separator and NVM_SYMLINK for the preferred node dir', async () => {
    const env = buildHarnessEnvironment(
      {
        APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        NVM_SYMLINK: 'C:\\Program Files\\nodejs',
        PATH: 'C:\\Windows\\System32'
      },
      'win32'
    )
    expect(env['PATH']?.split(';')[0]).toBe('C:\\Program Files\\nodejs')
    expect(env['PATH']).toContain(join('C:\\Users\\me\\AppData\\Roaming', 'npm'))
  })

  it('scans NVM_HOME for installed versions when no symlink is set', async () => {
    tmp = await mkdtemp(join(tmpdir(), 'cio-nvm-win-'))
    await mkdir(join(tmp, 'v24.18.0'), { recursive: true })
    await mkdir(join(tmp, 'v19.0.1'), { recursive: true })
    const env = buildHarnessEnvironment({ NVM_HOME: tmp, PATH: 'C:\\Windows\\System32' }, 'win32')
    expect(env['PATH']?.split(';')[0]).toBe(join(tmp, 'v24.18.0'))
  })
})
