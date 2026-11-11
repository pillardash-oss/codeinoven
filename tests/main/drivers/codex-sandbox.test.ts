import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  codexSandboxConfigArgs,
  codexSandboxPolicy,
  codexWritableRoots
} from '../../../src/main/drivers/codex/codex-tools'
import { codexGitWritableRoots } from '../../../src/main/drivers/codex/codex-git-roots'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-codex-sandbox-'))
  roots.push(root)
  return root
}

describe('Codex sandbox writable roots', () => {
  it('names a repository git directory that lives inside the project', async () => {
    const root = await project()
    await mkdir(join(root, '.git', 'objects'), { recursive: true })
    expect(codexGitWritableRoots(root)).toEqual([join(root, '.git')])
    expect(codexWritableRoots(root)).toEqual([root, join(root, '.git')])
  })

  it('follows the gitdir a worktree records and keeps its common directory', async () => {
    const main = await project()
    const common = join(main, '.git')
    const gitDir = join(common, 'worktrees', 'pr-7')
    await mkdir(gitDir, { recursive: true })
    const worktree = await project()
    await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`)
    expect(codexGitWritableRoots(worktree)).toEqual([gitDir, common])
  })

  it('resolves a relative gitdir against the project', async () => {
    const root = await project()
    await mkdir(join(root, 'git-data'), { recursive: true })
    await writeFile(join(root, '.git'), 'gitdir: ./git-data\n')
    expect(codexGitWritableRoots(root)).toEqual([join(root, 'git-data')])
  })

  it('adds nothing when the project has no readable git metadata', async () => {
    const root = await project()
    expect(codexGitWritableRoots(root)).toEqual([])
    expect(codexWritableRoots(root)).toEqual([root])
  })

  it('adds nothing when a gitdir file points at a missing directory', async () => {
    const root = await project()
    await writeFile(join(root, '.git'), 'gitdir: /nowhere/at/all\n')
    expect(codexGitWritableRoots(root)).toEqual([])
  })
})

describe('Codex sandbox policy', () => {
  it('lets an auto-review turn write the project and its git data with network on', async () => {
    const root = await project()
    await mkdir(join(root, '.git'), { recursive: true })
    expect(codexSandboxPolicy(root, false, 'auto_review')).toEqual({
      type: 'workspaceWrite',
      writableRoots: [root, join(root, '.git')],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    })
  })

  it('keeps a read-only turn and a full-access turn as they were', async () => {
    const root = await project()
    await mkdir(join(root, '.git'), { recursive: true })
    expect(codexSandboxPolicy(root, true, 'auto_review')).toEqual({
      type: 'readOnly',
      networkAccess: false
    })
    expect(codexSandboxPolicy(root, false, 'full_access')).toEqual({ type: 'dangerFullAccess' })
  })

  it('passes the same writable roots and network access to a one-shot exec', async () => {
    const root = await project()
    await mkdir(join(root, '.git'), { recursive: true })
    expect(codexSandboxConfigArgs(root, false, 'auto_review')).toEqual([
      '-c',
      `sandbox_workspace_write.writable_roots=[${[root, join(root, '.git')].map((value) => JSON.stringify(value)).join(', ')}]`,
      '-c',
      'sandbox_workspace_write.network_access=true'
    ])
  })

  it('adds no overrides to a read-only or full-access exec', async () => {
    const root = await project()
    expect(codexSandboxConfigArgs(root, true, 'auto_review')).toEqual([])
    expect(codexSandboxConfigArgs(root, false, 'full_access')).toEqual([])
  })
})
