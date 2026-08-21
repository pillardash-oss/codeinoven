import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildProcessEnvironment } from '../drivers/cli-environment'

/**
 * Dev-only compliance probe for the installed opencode harness.
 *
 * Proves that a lean custom agent's `permission.deny` prunes denied tool
 * schemas server-side on the HEADLESS prompt endpoint (`opencode serve`):
 * 1. Records the installed opencode version.
 * 2. Loads a temp project whose `.opencode/opencode.json` declares a probe
 *    agent that allows only lightweight tools and explicitly denies the heavy
 *    set.
 * 3. Sends the identical prompt under the full default agent and under the
 *    lean probe agent, then compares the provider-reported input tokens.
 *    A lean agent that prunes denied schemas/skills measures materially fewer
 *    input tokens than the full agent.
 * Never touches the machine-wide opencode config. Uses free/flash provider
 * models only when a provider answers; provider/model outages at probe time
 * produce a clearly-labeled environment error rather than a false negative.
 *
 * A passing probe writes a persisted, dev-only compliance record for the
 * installed opencode version. The startup agent merge consumes that record as
 * its gate: agents are installed only for a harness version that has actually
 * been proven deny-compliant (or when the operator sets the explicit override),
 * so the app never ships denied-schema pruning on an unverified harness.
 */

/** Dev-only persistence for the last deny-compliance result, keyed by opencode version. */
export const OPENCODE_DENY_COMPLIANCE_RECORD_PATH = join(
  homedir(),
  '.config',
  'pillardash',
  'codeinoven',
  'opencode-deny-compliance.json'
)

export interface PersistedDenyCompliance {
  opencodeVersion: string
  compliant: boolean
  recordedAt: number
  note: string
}

/** Record the last probe result so the startup merge can gate on proof. */
export async function recordDenyCompliance(result: DenyProbeResult): Promise<void> {
  const directory = dirname(OPENCODE_DENY_COMPLIANCE_RECORD_PATH)
  await mkdir(directory, { recursive: true })
  const record: PersistedDenyCompliance = {
    opencodeVersion: result.version,
    compliant: result.compliant,
    recordedAt: Date.now(),
    note: result.note
  }
  await writeFile(OPENCODE_DENY_COMPLIANCE_RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
}

/** Read the persisted compliance record for the installed opencode version, if any. */
export async function recordedDenyCompliance(
  version: string
): Promise<PersistedDenyCompliance | null> {
  try {
    const raw = await readFile(OPENCODE_DENY_COMPLIANCE_RECORD_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedDenyCompliance>
    if (parsed.opencodeVersion === version && typeof parsed.compliant === 'boolean') {
      return {
        opencodeVersion: version,
        compliant: parsed.compliant,
        recordedAt: typeof parsed.recordedAt === 'number' ? parsed.recordedAt : 0,
        note: typeof parsed.note === 'string' ? parsed.note : ''
      }
    }
    return null
  } catch {
    return null
  }
}

export interface DenyProbeResult {
  version: string
  compliant: boolean
  fullInputTokens: number | null
  leanInputTokens: number | null
  reductionInputTokens: number | null
  note: string
}

/** Installed opencode CLI version, or null when the CLI is unavailable. */
export function openCodeVersion(): string | null {
  try {
    const raw = execFileSync('opencode', ['--version'], {
      encoding: 'utf8',
      env: buildProcessEnvironment(),
      timeout: 15_000
    })
      .trim()
      .split(/\r?\n/u)[0]
      .trim()
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

async function startServe(projectDir: string): Promise<{
  baseUrl: string
  child: ReturnType<typeof spawn>
}> {
  return new Promise((resolve, reject) => {
    const child = spawn('opencode', ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: projectDir,
      env: buildProcessEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill()
        reject(new Error('Timed out waiting for opencode serve to announce a port'))
      }
    }, 30_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = buffer.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        resolve({ baseUrl: `http://127.0.0.1:${match[1] ?? ''}`, child })
      }
    })
    child.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    })
    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`opencode serve exited before announcing a port (code ${code})`))
      }
    })
  })
}

async function fetchJson(baseUrl: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, init)
  if (!res.ok) throw new Error(`opencode probe ${path} failed with ${res.status}`)
  return res.json()
}

/** POST and consume a no-content response (`prompt_async` returns 204 with an
 *  empty body — calling `.json()` on it throws `Unexpected end of JSON input`). */
async function postNoContent(baseUrl: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`opencode probe ${path} failed with ${res.status}`)
}

function stepFinishInputTokens(value: unknown): { input: number | null; total: number | null } {
  const messages = Array.isArray(value) ? value : []
  for (const message of messages) {
    const parts = Array.isArray(message?.['parts']) ? message['parts'] : []
    for (const part of parts) {
      const tokens = part?.['tokens']
      if (part?.['type'] === 'step-finish' && typeof tokens === 'object' && tokens !== null) {
        const input = typeof tokens['input'] === 'number' ? tokens['input'] : null
        const total = typeof tokens['total'] === 'number' ? tokens['total'] : null
        return { input, total }
      }
    }
  }
  return { input: null, total: null }
}

async function waitForMessage(
  baseUrl: string,
  sessionId: string,
  timeoutMs = 90_000
): Promise<{ input: number | null; total: number | null }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = (await fetchJson(baseUrl, `/session/${sessionId}/message`)) as Array<
      Record<string, unknown>
    >
    const usage = stepFinishInputTokens(value)
    if (usage.input !== null || usage.total !== null) return usage
    const errored = value.some((message) => {
      const info = message?.['info']
      return (
        typeof info === 'object' &&
        info !== null &&
        Boolean((info as Record<string, unknown>)['error'])
      )
    })
    if (errored) break
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  return { input: null, total: null }
}

async function runTurnMeasurement(
  baseUrl: string,
  sessionId: string,
  body: Record<string, unknown>
): Promise<{ input: number | null; total: number | null }> {
  await postNoContent(baseUrl, `/session/${sessionId}/prompt_async`, body)
  return waitForMessage(baseUrl, sessionId)
}

/**
 * Run the deny-compliance probe against the installed opencode harness.
 * Not for production use — dev measurement and CI gating only.
 */
export async function runOpenCodeDenyProbe(): Promise<DenyProbeResult> {
  const version = openCodeVersion()
  if (version === null) {
    return {
      version: 'unknown',
      compliant: false,
      fullInputTokens: null,
      leanInputTokens: null,
      reductionInputTokens: null,
      note: 'opencode CLI is unavailable'
    }
  }
  const projectDir = await mkdtemp(join(tmpdir(), 'opencode-deny-probe-'))
  let serve: { baseUrl: string; child: ReturnType<typeof spawn> } | null = null
  try {
    const configDir = join(projectDir, '.opencode')
    await mkdir(configDir, { recursive: true })
    await writeFile(
      join(configDir, 'opencode.json'),
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          agent: {
            'cio-probe-lean': {
              description: 'Deny-compliance probe agent (web tools only)',
              mode: 'primary',
              permission: {
                read: 'deny',
                edit: 'deny',
                glob: 'deny',
                grep: 'deny',
                list: 'deny',
                bash: 'deny',
                task: 'deny',
                todowrite: 'deny',
                skill: 'deny',
                lsp: 'deny',
                external_directory: 'deny',
                webfetch: 'allow',
                websearch: 'allow',
                question: 'allow'
              }
            }
          }
        },
        null,
        2
      ),
      'utf-8'
    )
    serve = await startServe(projectDir)
    const agents = (await fetchJson(serve.baseUrl, '/agent')) as Array<{
      name: string
      permission?: Array<{ permission: string; action: string }>
    }>
    const probeAgent = agents.find((agent) => agent.name === 'cio-probe-lean')
    if (!probeAgent) {
      return {
        version,
        compliant: false,
        fullInputTokens: null,
        leanInputTokens: null,
        reductionInputTokens: null,
        note: 'probe agent was not loaded by the harness'
      }
    }
    const bashPermission = probeAgent.permission?.find((entry) => entry.permission === 'bash')
    if (bashPermission?.action !== 'deny') {
      return {
        version,
        compliant: false,
        fullInputTokens: null,
        leanInputTokens: null,
        reductionInputTokens: null,
        note: 'probe agent bash permission did not resolve to deny'
      }
    }

    const model = { providerID: 'opencode', modelID: 'x-preview-f-free' }
    const promptParts = [{ type: 'text', text: 'Reply with the single word: pong' }]

    const fullSession = (await fetchJson(serve.baseUrl, '/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'full' })
    })) as { id: string }
    const fullUsage = await runTurnMeasurement(serve.baseUrl, fullSession.id, {
      model,
      parts: promptParts
    })

    const leanSession = (await fetchJson(serve.baseUrl, '/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'lean' })
    })) as { id: string }
    const leanUsage = await runTurnMeasurement(serve.baseUrl, leanSession.id, {
      model,
      agent: 'cio-probe-lean',
      parts: promptParts
    })

    if (fullUsage.input === null) {
      return {
        version,
        compliant: false,
        fullInputTokens: null,
        leanInputTokens: leanUsage.input,
        reductionInputTokens: null,
        note: 'full-agent turn produced no provider token report (model/provider outage at probe time)'
      }
    }
    if (leanUsage.input === null) {
      return {
        version,
        compliant: false,
        fullInputTokens: fullUsage.input,
        leanInputTokens: null,
        reductionInputTokens: null,
        note: 'lean-agent turn produced no provider token report (model/provider outage at probe time)'
      }
    }
    const reduction = fullUsage.input - leanUsage.input
    // Denied heavy tool/skill schemas must measurably shrink the assembled
    // prompt; a lean agent that prunes nothing fails the compliance gate.
    const compliant = leanUsage.input < fullUsage.input * 0.7
    const result: DenyProbeResult = {
      version,
      compliant,
      fullInputTokens: fullUsage.input,
      leanInputTokens: leanUsage.input,
      reductionInputTokens: reduction,
      note: compliant
        ? 'denied tool/skill schemas are pruned server-side on the headless prompt endpoint'
        : 'agent deny had little/no effect on the assembled prompt (harness non-compliant)'
    }
    // Persist the compliance proof so the startup agent merge is gated on the
    // installed harness actually honoring deny (finding 1).
    await recordDenyCompliance(result)
    return result
  } finally {
    if (serve) {
      serve.child.kill()
    }
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Human-line summary of the latest probe run for the dev log / progress record. */
export function formatDenyProbeResult(result: DenyProbeResult): string {
  const verdict = result.compliant ? 'COMPLIANT' : 'NON-COMPLIANT'
  return `opencode v${result.version} deny compliance: ${verdict} — full=${result.fullInputTokens ?? 'n/a'} lean=${result.leanInputTokens ?? 'n/a'} (reduction=${result.reductionInputTokens ?? 'n/a'}) — ${result.note}`
}
