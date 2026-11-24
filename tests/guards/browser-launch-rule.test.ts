/******************************************************************************
 *                                                                           *
 *   STOP.  THIS GUARD IS NOT NEGOTIABLE AND NOT EDITABLE TO GET GREEN.      *
 *                                                                           *
 *   It enforces one promise: an agent cannot launch its own browser.  The   *
 *   in-app browser is the only one, because it is the only one that shows   *
 *   the page the app is serving in the tab the user can watch.              *
 *                                                                           *
 *   The words alone lost twice: the prompt already forbade chromium,        *
 *   Playwright and Puppeteer, and models still hunted a Playwright cache,   *
 *   ran `--headless` screenshots and opened remote-debugging ports.  So the *
 *   rule is enforced in `unmanagedBrowserShellReason` and wired at every    *
 *   place an agent's shell command passes through, exactly like the process *
 *   kill and cua-driver blocks beside it.                                   *
 *                                                                           *
 *   DO NOT: unplug a wiring site, drop a banned form from the policy, turn  *
 *   the block into a permission card, or weaken an assertion.  Add the      *
 *   missing form to the policy instead.                                    *
 *                                                                           *
 ******************************************************************************/
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { unmanagedBrowserShellReason } from '../../src/lib/agent-control-policy'

const projectRoot = join(import.meta.dirname, '..', '..')

// Cheap tripwire for "someone emptied the file instead of deleting it".
const GUARD_CANARY = 'BROWSER-LAUNCH-GUARD-CANARY'

/** Every gate an agent's shell command passes through, including workers. */
const WIRING_SITES = [
  'src/main/drivers/pi/tools/core-tools-header.ts',
  'src/main/drivers/pi/tools/core-tools-events.ts',
  'src/main/drivers/pi/tools/core-tools-subagents.ts',
  'src/main/chat/chat-engine/chat-engine-permissions.ts'
] as const

const shell = (command: string): string | null => unmanagedBrowserShellReason('bash', { command })

describe('browser launch rule', () => {
  it('refuses the binary, the runner and the flags an agent reaches for', () => {
    for (const command of [
      'chromium --headless --dump-dom http://localhost:3000',
      'google-chrome --headless=new --screenshot=shot.png http://localhost:3000',
      'chrome-headless-shell --dump-dom http://localhost:3000',
      'firefox --screenshot http://localhost:3000',
      'npx playwright screenshot http://localhost:3000 out.png',
      'bunx playwright test',
      'open -a "Google Chrome" http://localhost:3000',
      'bash -c "chromium --headless --dump-dom http://localhost:3000"'
    ]) {
      expect(shell(command), command).not.toBeNull()
    }
  })

  it('still lets an agent read, search and test without a browser', () => {
    for (const command of [
      'rg -n "playwright" src',
      'grep -rn "chromium.launch" src/',
      'echo "chromium --headless"',
      'bun run test',
      'npm install',
      'curl -s http://127.0.0.1:3000/',
      'ls -la src/lib/browser'
    ]) {
      expect(shell(command), command).toBeNull()
    }
  })

  it('points a refused agent at the in-app browser instead of leaving it stuck', () => {
    const reason = shell('chromium --headless http://localhost:3000') ?? ''
    expect(reason).toContain('cio:browser')
    expect(reason).toContain('cio_util_init')
    expect(reason).toContain('in-app browser')
  })

  it('is never a permission card, so no tier can approve it', () => {
    expect(unmanagedBrowserShellReason('read', { path: 'playwright.md' })).toBeNull()
    expect(unmanagedBrowserShellReason('write', { content: 'chromium --headless' })).toBeNull()
    expect(unmanagedBrowserShellReason('bash', {})).toBeNull()
  })

  it('allows the headless fallback on a thread the app marked unavailable', () => {
    const command = 'chromium --headless --dump-dom http://localhost:3000'
    expect(
      unmanagedBrowserShellReason('bash', { command }, { threadBrowserAvailable: true })
    ).not.toBeNull()
    expect(
      unmanagedBrowserShellReason('bash', { command }, { threadBrowserAvailable: false })
    ).toBeNull()
  })

  it('reads the session flag the app sets for an Oven thread', () => {
    const command = 'chromium --headless --dump-dom http://localhost:3000'
    const previous = process.env['CIO_THREAD_BROWSER']
    try {
      process.env['CIO_THREAD_BROWSER'] = 'unavailable'
      expect(unmanagedBrowserShellReason('bash', { command })).toBeNull()
      // An explicit decision from the app still outranks the environment.
      expect(
        unmanagedBrowserShellReason('bash', { command }, { threadBrowserAvailable: true })
      ).not.toBeNull()
      process.env['CIO_THREAD_BROWSER'] = 'available'
      expect(unmanagedBrowserShellReason('bash', { command })).not.toBeNull()
    } finally {
      if (previous === undefined) delete process.env['CIO_THREAD_BROWSER']
      else process.env['CIO_THREAD_BROWSER'] = previous
    }
  })

  it('marks an Oven thread unavailable in the run environment it starts with', async () => {
    const source = await readFile(join(projectRoot, 'src/main/ovens/oven-pi-runtime.ts'), 'utf8')
    expect(source).toContain("CIO_THREAD_BROWSER: 'unavailable'")
  })

  it('makes a page question name the browser, so no model can claim there is none', async () => {
    const source = await readFile(
      join(
        projectRoot,
        'src/main/utilities/utility-orchestration-service/utility-orchestration-service-capability-invoke.ts'
      ),
      'utf8'
    )
    expect(source).toContain('matchesBrowserSearchIntent')
    expect(source).toContain('browserSearchEntry')
  })

  it('is wired at every gate, including the worker gate', async () => {
    for (const site of WIRING_SITES) {
      const source = await readFile(join(projectRoot, site), 'utf8')
      expect(source, `${site} must apply the browser block`).toContain(
        'unmanagedBrowserShellReason'
      )
    }
  })

  it('keeps this guard itself intact', async () => {
    const source = await readFile(join(import.meta.dirname, 'browser-launch-rule.test.ts'), 'utf8')
    expect(source).toContain(GUARD_CANARY)
    // Built from parts so this assertion cannot match its own source text.
    const focused = ['.', 'only', '('].join('')
    const skipped = ['.', 'skip', '('].join('')
    expect(source).not.toContain(focused)
    expect(source).not.toContain(skipped)
  })
})
