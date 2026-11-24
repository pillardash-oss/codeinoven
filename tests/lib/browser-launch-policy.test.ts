import { describe, expect, it } from 'vitest'
import { unmanagedBrowserShellReason } from '../../src/lib/agent-control-policy'

const shell = (command: string): string | null => unmanagedBrowserShellReason('bash', { command })

describe('browser launch guard', () => {
  it('ignores non-shell tools', () => {
    expect(unmanagedBrowserShellReason('read', { path: 'playwright.md' })).toBeNull()
    expect(unmanagedBrowserShellReason('write', { content: 'chromium --headless' })).toBeNull()
    expect(unmanagedBrowserShellReason('bash', {})).toBeNull()
  })

  it('ignores empty commands', () => {
    expect(shell('')).toBeNull()
    expect(shell('   ')).toBeNull()
  })

  it('allows ordinary shell work', () => {
    expect(shell('bun run test')).toBeNull()
    expect(shell('bun run check')).toBeNull()
    expect(shell('npm install')).toBeNull()
    expect(shell('curl -s http://127.0.0.1:3000/')).toBeNull()
    expect(shell('ls -la src/lib/browser')).toBeNull()
    expect(shell('cat src/main/browser/browser-service.ts')).toBeNull()
    expect(shell('bunx tsc --noEmit')).toBeNull()
  })

  it('allows searching text that mentions a browser', () => {
    expect(shell('rg -n "playwright" src')).toBeNull()
    expect(shell('grep -rn "chromium.launch" src/')).toBeNull()
    expect(shell('git log --oneline --grep=playwright')).toBeNull()
  })

  it('refuses a browser driven through a package runner', () => {
    expect(
      shell('npx playwright screenshot --browser=chromium http://localhost:3000 out.png')
    ).toContain('Not executed')
    expect(shell('bunx playwright test')).toContain('Not executed')
    expect(shell('npx @playwright/test --version')).toContain('Not executed')
  })

  it('refuses a browser binary', () => {
    expect(shell('chromium --headless --dump-dom http://localhost:3000')).toContain('Not executed')
    expect(
      shell(
        'google-chrome --headless=new --screenshot=/tmp/shot.png --window-size=1440,900 http://localhost:3000'
      )
    ).toContain('Not executed')
    expect(shell('chrome-headless-shell --dump-dom http://localhost:3000')).toContain(
      'Not executed'
    )
    expect(shell('firefox --screenshot http://localhost:3000')).toContain('Not executed')
  })

  it('refuses a browser launched by its installed path', () => {
    expect(
      shell(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 http://localhost:3000'
      )
    ).toContain('Not executed')
    expect(
      shell(
        '~/.cache/ms-playwright/chromium-1255/chrome-linux/chrome --headless http://localhost:3000'
      )
    ).toContain('Not executed')
  })

  it('refuses a browser opened through the macOS launcher', () => {
    expect(shell('open -a "Google Chrome" http://localhost:3000')).toContain('Not executed')
    expect(shell('open -na "Chromium" --args --headless')).toContain('Not executed')
  })

  it('refuses a launch written in code handed to an interpreter', () => {
    expect(
      shell('node -e "const { chromium } = require(\'playwright\'); chromium.launch()"')
    ).toContain('Not executed')
  })

  it('refuses a launch hidden in a compound command or a nested shell', () => {
    expect(
      shell(
        'curl -s http://127.0.0.1:3000/ && chromium --headless --screenshot=shot.png http://127.0.0.1:3000'
      )
    ).toContain('Not executed')
    expect(shell('bash -c "chromium --headless --dump-dom http://localhost:3000"')).toContain(
      'Not executed'
    )
  })

  it('points at the in-app browser instead', () => {
    const reason = shell('chromium --headless --dump-dom http://localhost:3000')
    expect(reason).toContain('cio:browser')
    expect(reason).toContain('cio_util_init')
    expect(reason).toContain('in-app browser')
  })
})

/**
 * The launch a command hides: a model that cannot get `npx playwright` past the
 * gate writes a script and runs it with node.
 */
describe('a script an executor was handed', () => {
  it('is refused when it launches a browser itself', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'cio-browser-script-'))
    try {
      const script = join(root, 'boot.mjs')
      await writeFile(
        script,
        "import { chromium } from 'playwright'\n" +
          "await chromium.launchPersistentContext('./profile', { headless: true })\n",
        'utf8'
      )
      const reason = unmanagedBrowserShellReason(
        'bash',
        { command: `node ${script}` },
        { cwd: root }
      )
      expect(reason).not.toBeNull()
      // A relative path in the session workspace is the same launch.
      expect(
        unmanagedBrowserShellReason('bash', { command: 'node boot.mjs' }, { cwd: root })
      ).not.toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is allowed when the script is ordinary work', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'cio-browser-script-'))
    try {
      const script = join(root, 'seed.mjs')
      await writeFile(script, "console.log('seeding')\n", 'utf8')
      expect(
        unmanagedBrowserShellReason('bash', { command: `node ${script}` }, { cwd: root })
      ).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
