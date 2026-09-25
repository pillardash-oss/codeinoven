import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent, ThreadSettings } from '../../../src/lib/types'
import { parseOpenCodeMajor } from '../../../src/lib/opencode-version'
import { rememberOpenCodeInstallation } from '../../../src/main/agents/opencode-installation'
import { createOpenCodeHarnessDriver } from '../../../src/main/drivers/opencode-harness-driver'
import { OpenCodeDriver } from '../../../src/main/drivers/opencode-driver'
import { OpenCodeV2Driver } from '../../../src/main/drivers/opencode-v2-driver'
import { discoverOpenCodeV2Catalog } from '../../../src/main/opencode-v2/opencode-v2-discovery'

/**
 * Real-binary end-to-end coverage for the single `opencode` harness.
 *
 * The suite needs an actual OpenCode install, so it is gated on
 * `OPENCODE_E2E_BINARY` (absolute path to `opencode`) and reports as skipped
 * everywhere else. It exists to prove the two things unit tests cannot: that the
 * app picks the transport matching the installed line, and that the chosen
 * transport really drives a live server.
 *
 *   OPENCODE_E2E_BINARY=/path/to/opencode bunx vitest run \
 *     tests/main/drivers/opencode-harness.e2e.test.ts
 *
 * A model is only needed for the turn test; `OPENCODE_E2E_MODEL` overrides the
 * default free Zen model when the sandbox has credentials for another one.
 */

const binary = process.env['OPENCODE_E2E_BINARY']
const model = process.env['OPENCODE_E2E_MODEL'] ?? 'opencode/mimo-v2.6-flash-free'
const maybe = binary ? describe : describe.skip

/** Scratch lives under the project's gitignored `.cio/tmp`, never the OS temp dir. */
const SANDBOX = resolve(process.cwd(), '.cio/tmp/opencode-e2e')
const HOME_DIR = join(SANDBOX, 'home')
const PROJECT_DIR = join(SANDBOX, 'project')

const sandboxEnv: NodeJS.ProcessEnv = {
  HOME: HOME_DIR,
  XDG_CONFIG_HOME: join(HOME_DIR, '.config'),
  XDG_DATA_HOME: join(HOME_DIR, '.local', 'share'),
  XDG_STATE_HOME: join(HOME_DIR, '.local', 'state'),
  XDG_CACHE_HOME: join(HOME_DIR, '.cache')
}

function installedVersion(): string {
  if (!binary) return ''
  return execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
}

const version = installedVersion()
const major = parseOpenCodeMajor(version)
const isV2 = Number.isFinite(major) && major >= 2

async function waitForIdle(events: AgentEvent[], sessionId: string): Promise<void> {
  const deadline = Date.now() + 600_000
  while (Date.now() < deadline) {
    if (events.some((event) => event.type === 'session.idle' && event.sessionId === sessionId)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for the V2 session to go idle')
}

maybe('OpenCode harness end to end', () => {
  beforeAll(async () => {
    await rm(SANDBOX, { recursive: true, force: true })
    await mkdir(join(HOME_DIR, '.config', 'opencode'), { recursive: true })
    await mkdir(PROJECT_DIR, { recursive: true })
    await writeFile(join(PROJECT_DIR, 'hello.txt'), 'hello-from-e2e\n', 'utf8')
    // A sandbox config keeps the probe off the developer's real install and
    // pins the model the turn test uses.
    await writeFile(
      join(HOME_DIR, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ $schema: 'https://opencode.ai/config.json', model }, null, 2),
      'utf8'
    )
  })

  afterAll(async () => {
    await rm(SANDBOX, { recursive: true, force: true })
  })

  it('selects the transport that matches the installed OpenCode line', () => {
    rememberOpenCodeInstallation({ command: binary ?? 'opencode', version, major })
    const driver = createOpenCodeHarnessDriver()
    // One harness id for both lines: the user never chooses a version.
    expect(driver.id).toBe('opencode')
    if (isV2) {
      expect(driver).toBeInstanceOf(OpenCodeV2Driver)
    } else {
      expect(driver).toBeInstanceOf(OpenCodeDriver)
    }
  })

  it.skipIf(!isV2)(
    'reads a real V2 catalog over the HTTP API',
    async () => {
      const result = await discoverOpenCodeV2Catalog({
        command: binary ?? 'opencode',
        cwd: PROJECT_DIR,
        env: sandboxEnv
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.catalog.providers.length).toBeGreaterThan(0)
      expect(result.catalog.models.length).toBeGreaterThan(0)
    },
    300_000
  )

  it.skipIf(!isV2)(
    'streams a real turn and mirrors its history',
    async () => {
      const driver = new OpenCodeV2Driver(undefined, undefined, sandboxEnv, binary ?? 'opencode')
      const events: AgentEvent[] = []
      driver.onEvent((event) => events.push(event))
      const settings: ThreadSettings = {
        harnessId: 'opencode',
        providerId: model.split('/')[0] ?? 'opencode',
        modelId: model.split('/').slice(1).join('/'),
        thinkingLevel: 'minimal',
        permissionLevel: 'auto_review'
      }
      try {
        const sessionId = await driver.createSession(PROJECT_DIR, 'e2e turn')
        await driver.sendPrompt(PROJECT_DIR, {
          sessionId,
          settings,
          text: 'Reply with the single word PONG. Do not use any tools.',
          attachments: []
        })
        await waitForIdle(events, sessionId)

        const streamed = events.some(
          (event) =>
            event.type === 'message.part.updated' &&
            event.part.type === 'text' &&
            event.part.text.trim().length > 0
        )
        expect(streamed).toBe(true)

        const messages = await driver.loadMessages(PROJECT_DIR, sessionId)
        const text = messages
          .flatMap((message) => message.parts)
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join(' ')
        expect(text).toMatch(/PONG/i)

        await driver.deleteSession(PROJECT_DIR, sessionId)
      } finally {
        driver.dispose()
      }
    },
    900_000
  )
})
