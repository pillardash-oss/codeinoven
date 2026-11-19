import { randomUUID } from 'node:crypto'
import type { StartOvenRunInput } from '../../lib/ovens'
import type {
  AgentAccountUsage,
  AgentBankedResets,
  AgentRateLimitWindow,
  AgentUsageCredits
} from '../../lib/types'
import { rateLimitWindows } from '../drivers/claude-code/claude-usage'
import { mapCodexRateLimits } from '../drivers/codex/codex-usage'
import { recordValue } from '../drivers/codex/codex-values'
import { Logger } from '../system/logger'
import type { OvenService } from './oven-service'

/**
 * Account quota read from an Oven when this machine has no such harness.
 *
 * Account usage is provider-level account state, not thread state, so the same
 * credential container answers the same question wherever the harness runs.
 * When the harness exists only on a remote Oven, that Oven is the only place a
 * quota probe can happen at all, and it happens through the run channel the
 * Ovens already use for turns: the harness is started there with the
 * credentials this app synced for the account, asked for its quota over the
 * protocol it already speaks, and stopped again.
 *
 * Two harnesses can answer that way today, because both expose their quota over
 * a stdio protocol: Codex through its app-server, Claude Code through its
 * `get_usage` control request. Every other harness keeps its quota behind a
 * resident local server or a local credential store, so this reports nothing
 * for them instead of inventing a reading.
 */

/** One quota probe is a side channel: a hover must never wait indefinitely. */
const PROBE_DEADLINE_MS = 20_000

/** How often the run's journal is read while a probe waits for its answer. */
const POLL_INTERVAL_MS = 120

/** How long a finished probe run may take to disappear from the Oven. */
const REMOVE_ATTEMPTS = 6
const REMOVE_RETRY_MS = 200

/**
 * How long one answer is reused.
 *
 * A hover repeats on every reveal, and each probe starts a harness process on
 * the Oven. One answer serves the reveals that follow it, and the same window
 * keeps the Accounts table from probing the same account twice.
 */
const USAGE_TTL_MS = 60_000

export type OvenAccountTelemetry = {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
  bankedResets?: AgentBankedResets
}

/** Everything one remote quota read needs, already resolved by the caller. */
export interface OvenAccountUsageTarget {
  ovenId: string
  harnessId: string
  providerId: string
  accountId: string
  /** An absolute directory on the Oven holding this account's credentials. */
  cwd: string
  /** The account's environment, as the Oven expects it (CODEX_HOME, ...). */
  environment: Record<string, string>
}

const cache = new Map<string, { telemetry: OvenAccountTelemetry | null; expiresAt: number }>()
const inflight = new Map<string, Promise<OvenAccountTelemetry | null>>()

function cacheKey(target: OvenAccountUsageTarget): string {
  return [target.ovenId, target.harnessId, target.providerId, target.accountId].join('\0')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Drop cached answers, for one Oven or for all of them. */
export function forgetOvenAccountUsage(ovenId?: string): void {
  if (!ovenId) {
    cache.clear()
    return
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${ovenId}\0`)) cache.delete(key)
  }
}

/**
 * Read one account's quota from an Oven, or `null` when the harness there
 * cannot answer over a stdio protocol.
 *
 * Answers are cached for a short window and concurrent reads for the same
 * account share one probe, so two surfaces opening at once never start two
 * harness processes on the same Oven.
 */
export function readOvenAccountUsage(
  service: OvenService,
  target: OvenAccountUsageTarget
): Promise<OvenAccountTelemetry | null> {
  const key = cacheKey(target)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.telemetry)
  const pending = inflight.get(key)
  if (pending) return pending
  const task = probeHarness(service, target)
    .then((telemetry) => {
      cache.set(key, { telemetry, expiresAt: Date.now() + USAGE_TTL_MS })
      return telemetry
    })
    .catch((error: unknown) => {
      Logger.dev(
        'Oven account usage probe failed:',
        error instanceof Error ? error.message : String(error)
      )
      return null
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, task)
  return task
}

function probeHarness(
  service: OvenService,
  target: OvenAccountUsageTarget
): Promise<OvenAccountTelemetry | null> {
  switch (target.harnessId) {
    case 'codex':
      return converse(
        service,
        target,
        { command: 'codex', args: ['app-server', '--listen', 'stdio://'] },
        readCodexTelemetry
      )
    case 'claude-code':
      return converse(
        service,
        target,
        {
          command: 'claude',
          args: [
            '--print',
            '--output-format',
            'stream-json',
            '--input-format',
            'stream-json',
            '--verbose'
          ]
        },
        readClaudeTelemetry
      )
    default:
      return Promise.resolve(null)
  }
}

interface HarnessLaunch {
  command: string
  args: string[]
}

async function converse(
  service: OvenService,
  target: OvenAccountUsageTarget,
  launch: HarnessLaunch,
  exchange: (conversation: RemoteConversation) => Promise<OvenAccountTelemetry | null>
): Promise<OvenAccountTelemetry | null> {
  const conversation = new RemoteConversation(service, target.ovenId, randomUUID())
  try {
    await conversation.start({
      id: conversation.runId,
      command: launch.command,
      args: launch.args,
      cwd: target.cwd,
      environment: target.environment
    })
    return await exchange(conversation)
  } finally {
    await conversation.close()
  }
}

/**
 * One harness process on the Oven, read as newline-delimited output.
 *
 * The Oven journals stdout and answers a cursor, so this keeps its own line
 * buffer and only ever asks for what it has not read. A probe is bounded by its
 * own deadline rather than the Oven's, because a harness that never answers is
 * a normal outcome for a machine that is signed out.
 */
class RemoteConversation {
  readonly runId: string
  private readonly lines: string[] = []
  private readonly deadline = Date.now() + PROBE_DEADLINE_MS
  private after = 0
  private buffer = ''
  private ended = false
  private closed = false
  private wake: (() => void) | undefined

  constructor(
    private readonly service: OvenService,
    private readonly ovenId: string,
    runId: string
  ) {
    this.runId = runId
  }

  get output(): readonly string[] {
    return this.lines
  }

  async start(input: StartOvenRunInput): Promise<void> {
    await this.service.start(this.ovenId, input)
    void this.poll()
  }

  async write(text: string): Promise<void> {
    await this.service.write(this.ovenId, this.runId, text)
  }

  /** Wait until the seen output satisfies `match`, the run ends, or the probe times out. */
  async waitFor(match: (lines: readonly string[]) => boolean): Promise<boolean> {
    for (;;) {
      if (match(this.lines)) return true
      if (this.ended || Date.now() > this.deadline) return match(this.lines)
      await this.nextSignal()
    }
  }

  /** Close stdin, stop the process, and let the Oven forget the run. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.service.write(this.ovenId, this.runId, '', true).catch(() => undefined)
    await this.service.stop(this.ovenId, this.runId).catch(() => undefined)
    await this.remove()
  }

  /**
   * Remove the finished run from the Oven's journal.
   *
   * The Oven refuses to remove a run whose process is still alive, and a
   * stopped harness takes a moment to exit, so this retries briefly. Runs are
   * kept in memory with a hard cap, so leaving one behind would eventually
   * refuse the next probe.
   */
  private async remove(): Promise<void> {
    for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
      try {
        await this.service.remove(this.ovenId, this.runId)
        return
      } catch {
        await delay(REMOVE_RETRY_MS)
      }
    }
  }

  private nextSignal(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined
        resolve()
      }, POLL_INTERVAL_MS)
      this.wake = () => {
        clearTimeout(timer)
        this.wake = undefined
        resolve()
      }
    })
  }

  private async poll(): Promise<void> {
    while (!this.closed) {
      try {
        const answer = await this.service.events(this.ovenId, this.runId, this.after)
        for (const event of answer.events) {
          this.after = Math.max(this.after, event.sequence)
          if (event.stream !== 'stdout') continue
          this.buffer += event.text
          const parts = this.buffer.split(/\r?\n/u)
          this.buffer = parts.pop() ?? ''
          this.lines.push(...parts)
        }
        if (answer.run.status !== 'running') this.ended = true
      } catch {
        this.ended = true
      }
      this.wake?.()
      if (this.ended) return
      await delay(POLL_INTERVAL_MS)
    }
  }
}

/** The JSON-RPC answer carrying this request id, if one has arrived. */
function jsonReply(lines: readonly string[], id: number): Record<string, unknown> | undefined {
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const message = recordValue(parsed)
    if (message && message['id'] === id) return message
  }
  return undefined
}

function hasJsonReply(lines: readonly string[], id: number): boolean {
  const reply = jsonReply(lines, id)
  return reply !== undefined && reply['error'] === undefined
}

/**
 * Codex reports quota through its app-server, the same surface a live turn
 * reads, so the probe performs the standard handshake and asks once.
 */
async function readCodexTelemetry(
  conversation: RemoteConversation
): Promise<OvenAccountTelemetry | null> {
  await conversation.write(
    `${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codeinoven', title: 'CodeInOven', version: '1' },
        capabilities: { experimentalApi: true }
      }
    })}\n`
  )
  if (!(await conversation.waitFor((lines) => hasJsonReply(lines, 1)))) return null
  await conversation.write(`${JSON.stringify({ method: 'initialized' })}\n`)
  await conversation.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read' })}\n`)
  if (!(await conversation.waitFor((lines) => hasJsonReply(lines, 2)))) return null
  const result = recordValue(jsonReply(conversation.output, 2)?.['result'])
  if (!result) return null
  const telemetry = mapCodexRateLimits(result)
  if (telemetry.rateLimits.length === 0 && !telemetry.credits && !telemetry.bankedResets)
    return null
  return {
    rateLimits: telemetry.rateLimits,
    ...(telemetry.credits ? { credits: telemetry.credits } : {}),
    ...(telemetry.bankedResets ? { bankedResets: telemetry.bankedResets } : {})
  }
}

/** The `get_usage` control answer, once the harness has sent it. */
function claudeUsageAnswer(lines: readonly string[]): Record<string, unknown> | undefined {
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const message = recordValue(parsed)
    if (message?.['type'] !== 'control_response') continue
    const response = recordValue(message['response'])
    if (response?.['request_id'] !== 'usage') continue
    return recordValue(response['response']) ?? undefined
  }
  return undefined
}

/**
 * Claude Code answers a `get_usage` control request with the account's plan
 * windows without running a model turn, so the probe asks and stops there. The
 * context answer is deliberately not requested: a fresh process holds no
 * conversation, so whatever occupancy it reported would belong to nobody.
 */
async function readClaudeTelemetry(
  conversation: RemoteConversation
): Promise<OvenAccountTelemetry | null> {
  await conversation.write(
    `${JSON.stringify({
      type: 'control_request',
      request_id: 'usage',
      request: { subtype: 'get_usage' }
    })}\n`
  )
  if (!(await conversation.waitFor((lines) => claudeUsageAnswer(lines) !== undefined))) return null
  const answer = claudeUsageAnswer(conversation.output)
  if (!answer || answer['rate_limits_available'] !== true) return null
  const rateLimits = rateLimitWindows(answer['rate_limits'])
  return rateLimits.length > 0 ? { rateLimits } : null
}

/**
 * Attach the identity a quota reading belongs to.
 *
 * The Oven answers with quota only; the ids come from the account the caller
 * resolved, so a reading can never be attributed to another account.
 */
export function ovenAccountUsage(
  target: Pick<OvenAccountUsageTarget, 'harnessId' | 'providerId' | 'accountId'>,
  telemetry: OvenAccountTelemetry
): AgentAccountUsage {
  return {
    harnessId: target.harnessId,
    providerId: target.providerId,
    accountId: target.accountId,
    ...telemetry
  }
}
