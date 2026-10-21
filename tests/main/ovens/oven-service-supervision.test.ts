import { describe, expect, it } from 'vitest'
import {
  SYSTEMD_UNIT_NAME,
  TERMUX_BOOT_SCRIPT,
  TERMUX_SERVICE_NAME,
  isTermuxPrefix,
  shellQuote,
  supervisionTarget,
  systemdUnitFile,
  termuxBootScript,
  termuxLogScript,
  termuxServiceDirectory,
  termuxServiceScript,
  type OvenSupervisionInput
} from '../../../src/main/ovens/remote/oven-service-supervision'

const prefix = '/data/data/com.termux/files/usr'

const termuxInput: OvenSupervisionInput = {
  nodePath: `${prefix}/bin/node`,
  servicePath: '/data/data/com.termux/files/home/.config/pillardash/codeinoven/ovens/service.mjs',
  dataRoot: '/data/data/com.termux/files/home/.config/pillardash/codeinoven/ovens',
  revision: 'abc123',
  home: '/data/data/com.termux/files/home',
  prefix
}

const linuxInput: OvenSupervisionInput = {
  nodePath: '/usr/bin/node',
  servicePath: '/home/dev/.config/pillardash/codeinoven/ovens/service.mjs',
  dataRoot: '/home/dev/.config/pillardash/codeinoven/ovens',
  revision: 'abc123',
  home: '/home/dev'
}

describe('termux supervision', () => {
  it('execs the daemon so runsv owns node instead of a shell holding it', () => {
    const script = termuxServiceScript(termuxInput)
    expect(script.startsWith(`#!${prefix}/bin/sh\n`)).toBe(true)
    expect(script).toContain('export CODEINOVEN_OVEN_DATA_ROOT=')
    expect(script).toContain('export CODEINOVEN_OVEN_REVISION=abc123')
    // One exec, no backgrounding: the child a crash escapes from is the bug.
    expect(script).toMatch(/^exec /mu)
    expect(script.trimEnd().endsWith('daemon')).toBe(true)
    expect(script).not.toContain('&')
  })

  it('drops the revision line when no revision is known', () => {
    const script = termuxServiceScript({ ...termuxInput, revision: undefined })
    expect(script).not.toContain('CODEINOVEN_OVEN_REVISION')
  })

  it('brings both sshd and the Oven up from the boot script, repeatably', () => {
    const script = termuxBootScript(termuxInput)
    expect(script).toContain(`export SVDIR=${prefix}/var/service`)
    expect(script).toContain(`${prefix}/bin/sv up sshd`)
    expect(script).toContain(`${prefix}/bin/sv up ${TERMUX_SERVICE_NAME}`)
    // Termux's own supervisor starter, so the boot script never reimplements it.
    expect(script).toContain(`${prefix}/etc/profile.d/start-services.sh`)
    // A boot broadcast can arrive more than once; nothing here may duplicate work.
    expect(script).not.toContain('sv restart')
    expect(script).toContain('termux-wake-lock')
  })

  it('starts the supervisor itself when Termux does not, so boot never ends silent', () => {
    const script = termuxBootScript(termuxInput)
    const lines = script.split('\n')
    const fallback = lines.findIndex((line) => line.startsWith('if ! '))
    expect(fallback).toBeGreaterThan(-1)
    expect(lines[fallback]).toContain(`${prefix}/bin/pgrep`)
    expect(lines[fallback + 1]).toContain(`${prefix}/bin/runsvdir`)
    // The fallback has to come before the services are asked for, or it is moot.
    expect(fallback).toBeLessThan(lines.findIndex((line) => line.includes(`sv up sshd`)))
  })

  it('keeps the daemon log where a failed start can be read', () => {
    const script = termuxLogScript(termuxInput)
    expect(script).toContain(`${prefix}/bin/svlogd`)
    expect(script).toContain(`${prefix}/var/log/cio-oven`)
  })

  it('names the runit service directory and boot script', () => {
    expect(termuxServiceDirectory(prefix)).toBe(`${prefix}/var/service/${TERMUX_SERVICE_NAME}`)
    expect(TERMUX_BOOT_SCRIPT).toBe('00-cio-oven.sh')
  })

  it('recognises only a Termux prefix, never a plain Linux one', () => {
    expect(isTermuxPrefix(prefix)).toBe(true)
    expect(isTermuxPrefix('/data/data/com.termux')).toBe(true)
    expect(isTermuxPrefix('/usr')).toBe(false)
    expect(isTermuxPrefix('/home/dev/com.termuxish')).toBe(false)
    expect(isTermuxPrefix(undefined)).toBe(false)
  })
})

describe('systemd supervision', () => {
  it('restarts the daemon instead of leaving it dead after a shutdown', () => {
    const unit = systemdUnitFile(linuxInput)
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).toContain('Type=simple')
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/home/dev/.config/pillardash/codeinoven/ovens/service.mjs" daemon'
    )
    expect(unit).toContain(
      'Environment="CODEINOVEN_OVEN_DATA_ROOT=/home/dev/.config/pillardash/codeinoven/ovens"'
    )
    expect(unit).toContain('Environment="CODEINOVEN_OVEN_REVISION=abc123"')
  })

  it('keeps a path with a space one argument', () => {
    const unit = systemdUnitFile({
      ...linuxInput,
      nodePath: '/opt/node runtime/bin/node',
      servicePath: '/home/dev/my oven/service.mjs'
    })
    expect(unit).toContain(
      'ExecStart="/opt/node runtime/bin/node" "/home/dev/my oven/service.mjs" daemon'
    )
  })

  it('uses one unit name the app and the machine agree on', () => {
    expect(SYSTEMD_UNIT_NAME).toBe('cio-oven.service')
  })
})

describe('supervision detection', () => {
  it('picks exactly one supervisor per machine, and none on Windows', () => {
    expect(
      supervisionTarget({ platform: 'android', prefix: undefined, systemdUserManager: false })
    ).toEqual({ termux: true, systemd: false })
    expect(supervisionTarget({ platform: 'linux', prefix, systemdUserManager: false })).toEqual({
      termux: true,
      systemd: false
    })
    expect(
      supervisionTarget({ platform: 'linux', prefix: undefined, systemdUserManager: true })
    ).toEqual({ termux: false, systemd: true })
    expect(
      supervisionTarget({ platform: 'linux', prefix: undefined, systemdUserManager: false })
    ).toEqual({ termux: false, systemd: false })
    expect(
      supervisionTarget({ platform: 'win32', prefix: undefined, systemdUserManager: true })
    ).toEqual({ termux: false, systemd: false })
  })
})

describe('shell quoting', () => {
  it('quotes only what needs it and survives a single quote', () => {
    expect(shellQuote('/usr/bin/node')).toBe('/usr/bin/node')
    expect(shellQuote('/home/my oven/node')).toBe("'/home/my oven/node'")
    expect(shellQuote("/home/dev's oven")).toBe("'/home/dev'\\''s oven'")
  })
})
