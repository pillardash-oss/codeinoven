import { antigravityModelSlugs } from '../drivers/antigravity-model-output'
import { holdAntigravitySelfUpdate } from '../drivers/antigravity/antigravity-self-update'
import { buildProcessEnvironmentAsync } from '../drivers/cli-environment'
import type { HarnessAuthAccount, HarnessAuthStatus } from '../drivers/driver.interface'
import { runHarnessCommand } from '../drivers/harness-runtime'

/**
 * Per-harness status parsers, plus the probe that feeds the one harness without
 * a status subcommand. Each turns a CLI's own output into a HarnessAuthStatus,
 * and the shared helpers normalise that output (ANSI, stable account ids) before
 * a row is built.
 */

export const STATUS_TIMEOUT_MS = 10_000
/** Status commands should emit a small response. Stop broken CLIs before they consume RAM. */
export const STATUS_OUTPUT_MAX_BYTES = 64 * 1024
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu')

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

export function accountId(label: string): string {
  return (
    label
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'account'
  )
}

export function parseOpenCodeStatus(output: string, succeeded: boolean): HarnessAuthStatus {
  const clean = stripAnsi(output)
  const accounts: HarnessAuthAccount[] = clean
    .split(/\r?\n/u)
    .map((line) => line.match(/●\s+(.+?)\s+(api|oauth)\s*$/iu))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => {
      const label = match[1]?.trim() ?? 'Provider'
      return {
        id: accountId(label),
        providerId: accountId(label),
        label,
        method: match[2]?.toLowerCase()
      }
    })
  const count = clean.match(/\b(\d+)\s+credentials?\b/iu)
  if (count) {
    return {
      state: Number.parseInt(count[1] ?? '0', 10) > 0 ? 'authenticated' : 'unauthenticated',
      accounts
    }
  }
  return {
    state: succeeded ? 'unknown' : 'error',
    accounts,
    detail: 'OpenCode did not report a recognizable credential status.'
  }
}

export function parseClaudeStatus(output: string, succeeded: boolean): HarnessAuthStatus {
  try {
    const parsed = JSON.parse(output) as unknown
    if (parsed && typeof parsed === 'object') {
      const status = parsed as Record<string, unknown>
      const loggedIn = status['loggedIn'] === true
      const method = typeof status['authMethod'] === 'string' ? status['authMethod'] : undefined
      const provider =
        typeof status['apiProvider'] === 'string' ? status['apiProvider'] : 'Anthropic'
      return {
        state: loggedIn ? 'authenticated' : 'unauthenticated',
        accounts: loggedIn
          ? [
              {
                id: accountId(provider),
                providerId: 'anthropic',
                label: provider,
                ...(method ? { method } : {}),
                active: true
              }
            ]
          : []
      }
    }
  } catch {
    // Fall through to a bounded, non-sensitive status.
  }
  return {
    state: succeeded ? 'unknown' : 'error',
    accounts: [],
    detail: 'Claude Code did not report a recognizable authentication status.'
  }
}

export function parseCodexStatus(output: string, succeeded: boolean): HarnessAuthStatus {
  const clean = stripAnsi(output).trim()
  if (/not logged in|logged out|no authentication/iu.test(clean)) {
    return { state: 'unauthenticated', accounts: [] }
  }
  const match = clean.match(/logged in(?:\s+using)?\s+(.+)/iu)
  if (match) {
    const method = match[1]?.trim()
    return {
      state: 'authenticated',
      accounts: [
        {
          id: 'openai',
          providerId: 'openai',
          label: 'OpenAI',
          ...(method ? { method } : {}),
          active: true
        }
      ]
    }
  }
  return {
    state: succeeded ? 'unknown' : 'error',
    accounts: [],
    detail: 'Codex did not report a recognizable login status.'
  }
}

/**
 * Antigravity keeps its Google credentials in the OS keyring and exposes no
 * `auth status` subcommand. `agy models` only lists model slugs when signed in
 * and otherwise exits with a "please sign in" notice, so it doubles as the
 * auth probe: model slugs imply an authenticated Google account.
 */
function parseAntigravityStatus(output: string, succeeded: boolean): HarnessAuthStatus {
  const clean = stripAnsi(output).trim()
  if (/please sign in|sign in to view|authentication required/iu.test(clean)) {
    return { state: 'unauthenticated', accounts: [] }
  }
  const hasSlugs = antigravityModelSlugs(clean).length > 0
  if (hasSlugs) {
    return {
      state: 'authenticated',
      accounts: [{ id: 'google', providerId: 'google', label: 'Google', active: true }]
    }
  }
  return {
    state: succeeded ? 'unknown' : 'error',
    accounts: [],
    detail: 'Antigravity did not report a recognizable authentication status.'
  }
}

/**
 * Antigravity CLI reads stdin and hangs when that pipe stays open without EOF,
 * so the shared execFile-based probe cannot be used. Spawn `agy models` with
 * stdin ignored and let the common parser classify the result.
 */
export async function readAntigravityStatus(
  _projectPath?: string,
  environment: NodeJS.ProcessEnv = {}
): Promise<HarnessAuthStatus> {
  let result: { succeeded: boolean; stdout: string; stderr: string }
  try {
    const probeEnvironment = await buildProcessEnvironmentAsync({ ...process.env, ...environment })
    await holdAntigravitySelfUpdate(probeEnvironment)
    const output = await runHarnessCommand('agy', ['models'], {
      env: probeEnvironment,
      timeoutMs: STATUS_TIMEOUT_MS,
      maxOutputBytes: STATUS_OUTPUT_MAX_BYTES
    })
    result = { succeeded: true, ...output }
  } catch (error) {
    result = {
      succeeded: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error)
    }
  }
  const output = result.stdout.trim() || result.stderr.trim()
  return parseAntigravityStatus(output, result.succeeded)
}
