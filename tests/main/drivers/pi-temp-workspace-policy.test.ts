import { describe, expect, it } from 'vitest'
import { piCoreToolsHeaderSource } from '../../../src/main/drivers/pi/tools/core-tools-header'

/**
 * The OS temp directory is banned for agent work.
 *
 * The rule lives inside the generated extension's source, so it is tested where
 * it is written: the marked block is lifted out of that source and run here, so
 * a change to the emitted text is a change to what these cases exercise. A temp
 * path is refused before any permission card, in every mode, with the session's
 * own scratch folder named. Reads are deliberately exempt so a file the user
 * attached from temp still opens.
 */
interface TempPolicy {
  reason(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined
}

function generatedPolicy(): TempPolicy {
  const source = piCoreToolsHeaderSource()
  const start = source.indexOf('// <cio-temp-workspace-policy>')
  const end = source.indexOf('// </cio-temp-workspace-policy>')
  if (start < 0 || end < start)
    throw new Error('The generated source lost its temp-workspace policy block.')
  const block = source.slice(start, end)
  const harness = new Function(
    'join',
    `${block}
    return { reason: tempWorkdirReason }`
  )
  const api = harness((...parts: string[]) => parts.join('/')) as TempPolicy
  return api
}

const WORKSPACE = '/Users/me/codeinoven'

describe('the generated temp-workspace policy', () => {
  it('refuses a shell command that stages work in the temp directory', () => {
    const policy = generatedPolicy()

    const reason = policy.reason(
      'bash',
      {
        command:
          'cd /Users/me/codeinoven && rm -rf /tmp/cio-crlf && mkdir -p /tmp/cio-crlf && ln -s /Users/me/codeinoven/node_modules node_modules'
      },
      WORKSPACE
    )

    expect(reason).toContain('/tmp')
    expect(reason).toContain('/Users/me/codeinoven/.cio/tmp')
    expect(reason).toContain('banned for agent work')
  })

  it('refuses every temp spelling the contract names', () => {
    const policy = generatedPolicy()
    const refused = [
      'echo hi > /tmp/out.txt',
      'curl -s -o /tmp/o.txt http://127.0.0.1:3000/',
      'cat /private/tmp/x',
      'ls /var/tmp/build',
      'find /var/folders/xy/T -maxdepth 1',
      'mkdir -p "$TMPDIR/stage"',
      'cp a b "$TEMP/"',
      'echo %TEMP%',
      'mktemp -d',
      'bun -e "console.log(os.tmpdir())"',
      'copy out.txt C:\\Users\\me\\AppData\\Local\\Temp\\out.txt',
      'dir C:\\Windows\\Temp'
    ]
    for (const command of refused) {
      expect(policy.reason('bash', { command }, WORKSPACE), command).toBeDefined()
    }
  })

  it('leaves the workspace’s own scratch alone', () => {
    const policy = generatedPolicy()
    const allowed = [
      'mkdir -p .cio/tmp/site',
      'echo hi > /Users/me/codeinoven/.cio/tmp/out.txt',
      'cd .cio/tmp && bun run build',
      // Longest-prefix work: a name that merely starts with "tmp" is not the
      // temp directory, and a workspace path that contains one is not either.
      'ls /Users/me/codeinoven/tmpfoo',
      'echo https://tmp.example.com/'
    ]
    for (const command of allowed) {
      expect(policy.reason('bash', { command }, WORKSPACE), command).toBeUndefined()
    }
  })

  it('refuses writes and edits in temp but still opens an attached temp file', () => {
    const policy = generatedPolicy()

    expect(policy.reason('write', { path: '/tmp/report.md' }, WORKSPACE)).toBeDefined()
    expect(policy.reason('edit', { file_path: '/tmp/report.md' }, WORKSPACE)).toBeDefined()
    expect(policy.reason('read', { path: '/tmp/report.md' }, WORKSPACE)).toBeUndefined()
    expect(policy.reason('grep', { path: '/tmp/report.md' }, WORKSPACE)).toBeUndefined()
    // A file the agent writes into its own scratch is ordinary work.
    expect(policy.reason('write', { path: '.cio/tmp/report.md' }, WORKSPACE)).toBeUndefined()
  })
})
