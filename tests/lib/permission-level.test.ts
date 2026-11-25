import { describe, expect, it } from 'vitest'
import {
  isOvenMode,
  isUnrestrictedLevel,
  permissionPolicyMode
} from '../../src/lib/permission-level'

describe('permission level semantics', () => {
  it('recognizes Oven Mode only for oven_mode', () => {
    expect(isOvenMode('oven_mode')).toBe(true)
    expect(isOvenMode('full_access')).toBe(false)
    expect(isOvenMode('auto_review')).toBe(false)
    expect(isOvenMode(undefined)).toBe(false)
    expect(isOvenMode(null)).toBe(false)
  })

  it('treats full_access and oven_mode as the unrestricted levels', () => {
    expect(isUnrestrictedLevel('oven_mode')).toBe(true)
    expect(isUnrestrictedLevel('full_access')).toBe(true)
    expect(isUnrestrictedLevel('auto_review')).toBe(false)
    expect(isUnrestrictedLevel(undefined)).toBe(false)
    expect(isUnrestrictedLevel(null)).toBe(false)
  })

  it('maps every level onto the policy mode it evaluates with', () => {
    expect(permissionPolicyMode('auto_review')).toBe('auto_review')
    expect(permissionPolicyMode('full_access')).toBe('full_access')
    // Oven Mode keeps its own mode: the policy treats it exactly like Full
    // Access apart from the protection Full Access still applies, so mapping it
    // down would put the sensitive-file card back.
    expect(permissionPolicyMode('oven_mode')).toBe('oven_mode')
    expect(permissionPolicyMode(undefined)).toBe('auto_review')
    expect(permissionPolicyMode(null)).toBe('auto_review')
  })
})
