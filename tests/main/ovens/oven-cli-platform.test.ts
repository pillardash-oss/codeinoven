import { describe, expect, it } from 'vitest'
import { agentPlatformFor } from '../../../packages/cio-oven/src/descriptor'
import { defaultSshPortFor, sshPortCandidates } from '../../../packages/cio-oven/src/commands'

describe('oven agent platform', () => {
  it('treats Termux on Android as the Linux Oven it is', () => {
    // `process.platform` is `android` there, and npm reads the same value when
    // it applies a package's `os` field, which is why the published package
    // lists it. The machine is a Linux userspace, so it takes the Linux plan.
    expect(agentPlatformFor('android')).toBe('linux')
  })

  it('keeps the three desktop families as they are', () => {
    expect(agentPlatformFor('linux')).toBe('linux')
    expect(agentPlatformFor('darwin')).toBe('darwin')
    expect(agentPlatformFor('win32')).toBe('win32')
  })

  it('names the machine that cannot be an Oven instead of guessing a plan', () => {
    expect(() => agentPlatformFor('aix')).toThrow(/reports aix/u)
    expect(() => agentPlatformFor('freebsd')).toThrow(/reports freebsd/u)
  })
})

describe('oven CLI SSH port on Termux', () => {
  it('offers the port Termux can actually bind', () => {
    // Android refuses ports below 1024 to an unprivileged process, so 22 is an
    // endpoint no Termux `sshd` can serve, while 8022 is its own default.
    expect(defaultSshPortFor('android')).toBe(8022)
    expect(defaultSshPortFor('linux')).toBe(22)
    expect(defaultSshPortFor('darwin')).toBe(22)
    expect(defaultSshPortFor('win32')).toBe(22)
  })

  it('dials the platform default when nothing was detected', () => {
    expect(sshPortCandidates(null, 8022)).toEqual([8022])
    expect(sshPortCandidates(2222, 8022)).toEqual([2222, 8022])
    expect(sshPortCandidates(null)).toEqual([22])
  })
})
