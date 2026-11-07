import { describe, expect, it } from 'vitest'
import { tmpdir } from 'os'
import { resolve } from 'path'
import {
  PermissionPolicy,
  classifyPermissionRisk,
  normalizePermissionName
} from '../../../src/main/permissions/permission-policy'

const projectRoot = resolve('/workspace/project')

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
      scope: { projectRoot, paths: [resolve(projectRoot, 'src/main.ts')] }
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

    expect(policy.evaluate({ permission: 'read', paths: ['.git/config'] }).decision).toBe('ask')
    expect(policy.evaluate({ permission: 'read', paths: ['.env.local'] })).toMatchObject({
      decision: 'ask',
      risk: 'critical'
    })
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

  it('runs high-risk work outside the project root in auto_review mode', () => {
    const policy = new PermissionPolicy({ projectRoot, mode: 'auto_review' })

    // Only critical work asks in Auto Review, so the project boundary no longer
    // parks a read or an edit of a file elsewhere behind a card.
    expect(
      policy.evaluate({ permission: 'edit', paths: [resolve('/Users/me/other-project/src/a.ts')] })
    ).toMatchObject({ decision: 'auto_review', approved: true, risk: 'high' })
    expect(policy.evaluate({ permission: 'read', paths: ['../outside.txt'] })).toMatchObject({
      decision: 'auto_review',
      approved: true,
      risk: 'low'
    })
    expect(
      policy.evaluate({ permission: 'write-file', paths: ['/Users/me/other-project/src/a.ts'] })
        .approved
    ).toBe(true)
    // A critical request still answers for the path it names.
    expect(
      policy.evaluate({ permission: 'shell', paths: ['/Users/me/other-project/run.sh'] })
    ).toMatchObject({ decision: 'ask', approved: false, risk: 'critical' })
  })

  it('asks for a tool it cannot classify', () => {
    const policy = new PermissionPolicy({ projectRoot, mode: 'auto_review' })

    expect(policy.evaluate({ permission: 'mcp-tool', unclassifiedTool: 'mcp_tool' })).toMatchObject(
      { decision: 'ask', approved: false, risk: 'critical' }
    )
  })

  it('allows system temporary paths in auto_review mode', () => {
    const policy = new PermissionPolicy({
      projectRoot,
      mode: 'auto_review'
    })

    const result = policy.evaluate({ permission: 'read', paths: [resolve(tmpdir(), 'build.log')] })
    expect(result.approved).toBe(true)
  })

  it('never prompts for work confined to a scratch folder, deletes included', () => {
    const scratch = resolve(projectRoot, '.cio')
    const policy = new PermissionPolicy({
      projectRoot,
      mode: 'auto_review',
      scratchPaths: [scratch]
    })

    expect(policy.evaluate({ permission: 'delete', path: '.cio/tmp/pkg.tgz' })).toMatchObject({
      decision: 'auto_review',
      approved: true
    })
    expect(
      policy.evaluate({ permission: 'Bash', commands: ['rm -rf .cio/tmp/cio-oven-pkg'] })
    ).toMatchObject({ decision: 'auto_review', approved: true })
    expect(
      policy.evaluate({
        permission: 'Bash',
        commands: ['cd .cio/tmp && rm -rf cio-oven-pkg && mkdir -p cio-oven-pkg']
      })
    ).toMatchObject({ decision: 'auto_review', approved: true })
    expect(
      policy.evaluate({ permission: 'Bash', commands: ['cd .cio/tmp && npm pack --silent 2>&1'] })
    ).toMatchObject({ decision: 'auto_review', approved: true })
  })

  it('still asks when a scratch-rooted request can leave scratch', () => {
    const scratch = resolve(projectRoot, '.cio')
    const policy = new PermissionPolicy({
      projectRoot,
      mode: 'auto_review',
      scratchPaths: [scratch]
    })

    // Platform-owned folders inside scratch stay gated.
    expect(
      policy.evaluate({ permission: 'delete', path: '.cio/specs/login/spec.md' }).approved
    ).toBe(false)
    expect(
      policy.evaluate({ permission: 'Bash', commands: ['rm -rf .cio/git/pr/12'] }).approved
    ).toBe(false)
    // Traversal, absolute paths, and another shell stay gated.
    expect(
      policy.evaluate({ permission: 'Bash', commands: ['cd .cio/tmp && rm -rf ../../src'] })
        .approved
    ).toBe(false)
    expect(
      policy.evaluate({ permission: 'Bash', commands: ['rm -rf /Users/me/Documents'] }).approved
    ).toBe(false)
    // A command that acts on its working directory is only scratch-confined once
    // the chain has entered scratch.
    expect(policy.evaluate({ permission: 'Bash', commands: ['git clean -fdx'] }).approved).toBe(
      false
    )
    // A wrapper that evaluates another command cannot make a destructive request
    // scratch-confined, so the destructive permission itself still asks.
    expect(
      policy.evaluate({
        permission: 'delete',
        paths: ['.cio/tmp/pkg'],
        commands: ['bash -c "rm -rf pkg"']
      }).approved
    ).toBe(false)
  })

  it('never prompts for a destructive command confined to the session workspace', () => {
    const workspace = resolve('/workspace/assistant-cwd/abc')
    const policy = new PermissionPolicy({
      projectRoot: workspace,
      mode: 'auto_review',
      workspaceRoots: [workspace]
    })

    // An assistant staging a site inside its own workspace deletes the staged
    // tree and rebuilds it in one chain. Redirections and globs in the other
    // segments do not hide what the delete removes.
    expect(
      policy.evaluate({
        permission: 'bash',
        commands: [
          `cd ${workspace}/dispatch/site && rm -rf scratch/testsite && mkdir -p scratch/testsite/build && cp apply/static/*.txt scratch/testsite/static/ && printf '# placeholder\\n' > scratch/testsite/static/robots.txt`
        ]
      })
    ).toMatchObject({ decision: 'auto_review', approved: true })
  })

  it('still asks when a destructive command can leave the session workspace', () => {
    const workspace = resolve('/workspace/assistant-cwd/abc')
    const policy = new PermissionPolicy({
      projectRoot: workspace,
      mode: 'auto_review',
      workspaceRoots: [workspace]
    })

    expect(
      policy.evaluate({ permission: 'bash', commands: ['rm -rf /Users/me/Documents'] })
    ).toMatchObject({ decision: 'ask' })
    expect(
      policy.evaluate({ permission: 'bash', commands: ['cd /tmp && rm -rf build'] })
    ).toMatchObject({ decision: 'ask' })
    // A glob hides its targets.
    expect(policy.evaluate({ permission: 'bash', commands: ['rm -rf *'] })).toMatchObject({
      decision: 'ask'
    })
    // Wrappers evaluate another command, so nothing is proven.
    expect(
      policy.evaluate({ permission: 'bash', commands: [`bash -c 'ls && rm -rf scratch'`] })
    ).toMatchObject({ decision: 'ask' })
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
      risk: 'critical',
      approval: { required: true, expiresAt: 46_000 },
      ledger: {
        permission: '',
        decision: 'ask',
        risk: 'critical',
        scope: { projectRoot, paths: [resolve(projectRoot, 'internal-only.txt')] },
        expiresAt: 46_000
      }
    })
  })
})
