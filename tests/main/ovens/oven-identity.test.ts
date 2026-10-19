import { describe, expect, it } from 'vitest'
import { authorizedKeyPlan } from '../../../packages/cio-oven/src/identity'

const HOME = '/home/dev'

describe('authorizedKeyPlan', () => {
  it('uses the per-user file for a standard Windows account', () => {
    const plan = authorizedKeyPlan({
      platform: 'win32',
      administrator: false,
      home: HOME,
      programData: 'C:\\ProgramData'
    })
    expect(plan.kind).toBe('standard')
    expect(plan.requiredFile).toBe('/home/dev/.ssh/authorized_keys')
    expect(plan.adminFile).toBeNull()
    expect(plan.files).toEqual(['/home/dev/.ssh/authorized_keys'])
  })

  it('requires the machine-wide file for an administrator account', () => {
    const plan = authorizedKeyPlan({
      platform: 'win32',
      administrator: true,
      home: HOME,
      programData: 'C:\\ProgramData'
    })
    expect(plan.kind).toBe('administrator')
    expect(plan.adminFile).toBe('C:\\ProgramData/ssh/administrators_authorized_keys')
    expect(plan.requiredFile).toBe(plan.adminFile)
    // sshd skips the per-user file for this account class, so the machine-wide
    // file is the one that decides whether a connection is accepted.
    expect(plan.files[0]).toBe(plan.adminFile)
  })

  it('never points a POSIX account at a Windows file', () => {
    for (const platform of ['linux', 'darwin']) {
      const plan = authorizedKeyPlan({
        platform,
        administrator: false,
        home: HOME,
        programData: 'C:\\ProgramData'
      })
      expect(plan.kind).toBe('standard')
      expect(plan.adminFile).toBeNull()
      expect(plan.requiredFile).toBe('/home/dev/.ssh/authorized_keys')
    }
  })
})
