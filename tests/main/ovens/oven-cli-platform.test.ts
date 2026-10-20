import { describe, expect, it } from 'vitest'
import { agentPlatformFor } from '../../../packages/cio-oven/src/descriptor'

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
