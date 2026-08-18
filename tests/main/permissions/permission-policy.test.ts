import { describe, expect, it } from 'vitest'
import {
  PermissionPolicy,
  classifyPermissionRisk,
  normalizePermissionName
} from '../../../src/main/permissions/permission-policy'

const projectRoot = '/workspace/project'

describe('permission policy', () => {
  it('normalizes permission names and assigns each risk tier', () => {
    expect(normalizePermissionName(' File_Read:Contents ')).toBe('file-read-contents')
    expect(classifyPermissionRisk('read')).toBe('low')
    expect(classifyPermissionRisk('inspect-status')).toBe('medium')
    expect(classifyPermissionRisk('write-file')).toBe('high')
    expect(classifyPermissionRisk('shell-exec')).toBe('critical')
  })

  it('auto-approves every permission that is not explicitly denied in auto_review mode', () => {
    const policy = new PermissionPolicy({ projectRoot, mode: 'auto_review' })

    expect(policy.evaluate({ permission: 'SEARCH', path: 'src/main.ts' })).toMatchObject({
      decision: 'auto_review',
      approved: true,
      risk: 'low',
      approval: { required: false },
      scope: { projectRoot, paths: [`${projectRoot}/src/main.ts`] }
    })
    expect(policy.evaluate({ permission: 'write-file', path: 'src/main.ts' }).approved).toBe(true)
    expect(policy.evaluate({ permission: 'shell-exec' })).toMatchObject({
      decision: 'auto_review',
      approved: true,
      risk: 'critical',
      approval: { required: false }
    })
    expect(policy.evaluate({ permission: 'network-fetch' }).approved).toBe(true)
    expect(policy.evaluate({ permission: 'credential-read' }).approved).toBe(true)
  })

  it('still asks for explicitly denied paths in auto_review mode', () => {
    const policy = new PermissionPolicy({
      projectRoot,
      mode: 'auto_review',
      now: () => 1000,
      protectedPathPatterns: ['internal-only.txt']
    })

    expect(policy.evaluate({ permission: 'read', paths: ['../outside.txt'] }).reason).toContain(
      'traversal'
    )
    expect(policy.evaluate({ permission: 'read', paths: ['.git/config'] }).decision).toBe('ask')
    expect(policy.evaluate({ permission: 'read', paths: ['.env.local'] }).decision).toBe('ask')
    expect(policy.evaluate({ permission: 'read', paths: ['secrets/token.txt'] }).decision).toBe(
      'ask'
    )
    expect(policy.evaluate({ permission: 'read', paths: ['bun.lock'] }).decision).toBe('ask')
    expect(policy.evaluate({ permission: 'read', paths: ['internal-only.txt'] }).decision).toBe(
      'ask'
    )
    expect(policy.evaluate({ permission: 'delete-file', path: 'build/output.txt' })).toMatchObject({
      decision: 'ask',
      approved: false,
      risk: 'critical'
    })
    expect(policy.evaluate({ permission: 'Bash', commands: ['rm -rf build/cache'] })).toMatchObject(
      {
        decision: 'ask',
        approved: false,
        risk: 'critical'
      }
    )
    expect(policy.evaluate({ permission: 'Bash', commands: ['bun run test'] }).approved).toBe(true)
  })

  it('allows /tmp/ paths in auto_review mode', () => {
    const policy = new PermissionPolicy({
      projectRoot,
      mode: 'auto_review'
    })

    const result = policy.evaluate({ permission: 'read', paths: ['/tmp/build.log'] })
    expect(result.approved).toBe(true)
  })

  it('runs every operation in yolo mode under full_access, including home directory paths', () => {
    const policy = new PermissionPolicy({ projectRoot, mode: 'full_access', now: () => 1000 })

    expect(policy.evaluate({ permission: 'write-file', path: 'src/main.ts' })).toMatchObject({
      decision: 'full_access',
      approved: true,
      approval: { required: false }
    })
    expect(policy.evaluate({ permission: 'delete-file', paths: ['.git/config'] })).toMatchObject({
      decision: 'full_access',
      approved: true
    })
    expect(policy.evaluate({ permission: 'shell-exec', path: '/Users/me/.zshrc' })).toMatchObject({
      decision: 'full_access',
      approved: true,
      approval: { required: false }
    })
  })

  it('uses configurable approval expiry and records a ledger-ready decision for denied paths', () => {
    const policy = new PermissionPolicy({
      projectRoot,
      mode: 'auto_review',
      approvalTtlMs: 45_000,
      now: () => 1_000,
      protectedPathPatterns: ['internal-only.txt']
    })

    const result = policy.evaluate({
      permission: 'modify-settings',
      paths: ['internal-only.txt']
    })

    expect(result).toMatchObject({
      decision: 'ask',
      approved: false,
      risk: 'high',
      approval: { required: true, expiresAt: 46_000 },
      ledger: {
        permission: '',
        decision: 'ask',
        risk: 'high',
        scope: { projectRoot, paths: [`${projectRoot}/internal-only.txt`] },
        expiresAt: 46_000
      }
    })
  })
})
