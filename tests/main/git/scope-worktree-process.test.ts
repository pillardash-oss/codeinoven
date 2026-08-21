import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGit, runSetupCommand } from '../../../src/main/git/scope-worktree-process'
import { parseWorktreePorcelain } from '../../../src/main/git/scope-worktree-service'

const temporaryPaths: string[] = []

function tempDir(prefix = 'scope-proc-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('ScopeWorktreeProcess', () => {
  it.skipIf(process.platform === 'win32')('runs git with structured arguments and no shell', async () => {
    const dir = tempDir()
    const output = await runGit(['--version'], { cwd: dir })
    expect(output).toMatch(/git version/)
  })

  it.skipIf(process.platform === 'win32')('reports non-zero exits as results for setup commands', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'fail.sh'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    const result = await runSetupCommand(
      { executable: join(dir, 'fail.sh'), args: [] },
      { cwd: dir }
    )
    expect(result.exitCode).toBe(3)
  })

  it.skipIf(process.platform === 'win32')('runs commands with arguments and captures bounded output', async () => {
    const dir = tempDir()
    const result = await runSetupCommand(
      { executable: 'sh', args: ['-c', 'echo cloudoku-safe-output'] },
      { cwd: dir }
    )
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('cloudoku-safe-output')
  })

  it('parses NUL-delimited porcelain without locale assumptions', () => {
    const output =
      [
        'worktree /repo/main',
        'HEAD 321b5797323cca4a5c09a2393b919c94a6d7961e',
        'branch refs/heads/main',
        '',
        'worktree /config/projects/p1/scope/feature',
        'HEAD 321b5797323cca4a5c09a2393b919c94a6d7961e',
        'branch refs/heads/cio/feature',
        'locked because test',
        'prunable',
        ''
      ].join('\0') + '\0'
    const list = parseWorktreePorcelain(output)
    expect(list.entries).toHaveLength(2)
    const worktree = list.entries[1]!
    expect(worktree.path).toBe('/config/projects/p1/scope/feature')
    expect(worktree.head).toBe('refs/heads/cio/feature')
    expect(worktree.locked).toBe(true)
    expect(worktree.prunable).toBe(true)
  })
})
