import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { AgentBankedResets, AgentRateLimitWindow, AgentUsageCredits } from '../../lib/types'
import { Logger } from '../system/logger'
import {
  mapOpenCodeAccountUsage,
  OPENCODE_ACCOUNT_PROVIDER_IDS,
  OPENCODE_ACCOUNT_USAGE_ENDPOINT
} from './opencode-provider-usage'
import { CHATGPT_USAGE_ENDPOINT, mapChatGptPlanUsage } from './pi/pi-chatgpt-usage'

/**
 * On-demand account quota and prepaid-credit balances for pi's providers.
 *
 * Pi stores provider auth in `~/.pi/agent/auth.json`; the gateways that expose
 * a credit-balance endpoint are probed with the stored credential so the
 * battery popover can show "how much is left" the same way codex/claude-code
 * report plan balances, and a Codex-style ChatGPT credential answers the
 * ChatGPT plan-usage route with the subscription windows, credits, and banked
 * resets. Providers without a known route return null.
 */

interface PiAuthEntry {
  type?: unknown
  key?: unknown
  access?: unknown
  /** ChatGPT account id stored by Pi's Codex-style sign-in (`openai-codex`). */
  accountId?: unknown
}

const CREDITS_TIMEOUT_MS = 5_000
const CREDITS_CACHE_TTL_MS = 60_000

interface PiProviderUsage {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
  bankedResets?: AgentBankedResets
}

interface CachedUsage {
  usage: PiProviderUsage
  fetchedAt: number
}

const usageCache = new Map<string, CachedUsage>()

function piAuthPath(accountEnvironment: NodeJS.ProcessEnv): string {
  const agentDirectory = accountEnvironment['PI_CODING_AGENT_DIR']?.trim()
  return join(agentDirectory || join(homedir(), '.pi', 'agent'), 'auth.json')
}

async function piAuthEntry(providerId: string, authPath: string): Promise<PiAuthEntry | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(authPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const entry = (parsed as Record<string, unknown>)[providerId]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    return entry as PiAuthEntry
  } catch {
    return null
  }
}

function credentialValue(entry: PiAuthEntry): string | undefined {
  if (typeof entry.key === 'string' && entry.key.length > 0) return entry.key
  if (typeof entry.access === 'string' && entry.access.length > 0) return entry.access
  return undefined
}

/**
 * The ChatGPT account id that authenticates the plan-usage route. Pi's
 * Codex-style sign-in stores it on the credential; when it is absent the id can
 * still be read from the access token's `chatgpt_account_id` claim. The modern
 * `openai` sign-in token carries neither, which is why it answers no plan data.
 */
function chatGptAccountId(entry: PiAuthEntry | null): string | undefined {
  if (typeof entry?.accountId === 'string' && entry.accountId.length > 0) return entry.accountId
  const access = typeof entry?.access === 'string' ? entry.access : undefined
  if (!access) return undefined
  const parts = access.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
    const auth = (payload as Record<string, unknown>)['https://api.openai.com/auth']
    if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) return undefined
    const id = (auth as Record<string, unknown>)['chatgpt_account_id']
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

async function fetchJson(
  url: string,
  credential: string,
  extraHeaders: Record<string, string> = {}
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${credential}`, ...extraHeaders },
      signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    return body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch (error) {
    Logger.dev('Pi provider credits fetch failed:', error)
    return null
  }
}

/**
 * Probe one pi provider's account quota and prepaid-credit balance. Cached for
 * 60s per account container and provider so repeated battery hovers never
 * hammer gateway endpoints or leak one account's result into another account.
 * Unknown providers resolve to null   the popover simply omits provider usage.
 */
export async function fetchPiProviderUsage(
  providerId: string | undefined,
  accountEnvironment: NodeJS.ProcessEnv = {}
): Promise<PiProviderUsage | null> {
  if (!providerId) return null
  const authPath = piAuthPath(accountEnvironment)
  const cacheKey = `${authPath}\0${providerId}`
  const cached = usageCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CREDITS_CACHE_TTL_MS) return cached.usage

  let credits: AgentUsageCredits | null = null
  let bankedResets: AgentBankedResets | undefined
  const rateLimits: AgentRateLimitWindow[] = []
  const entry = await piAuthEntry(providerId, authPath)
  const credential = entry ? credentialValue(entry) : undefined
  const accountId = chatGptAccountId(entry)
  if (credential && accountId) {
    // Codex-style ChatGPT credential: answer with the subscription plan quota
    // and banked resets. The modern `openai` sign-in has no account id, so this
    // route is skipped for it and the battery shows only context usage.
    const body = await fetchJson(CHATGPT_USAGE_ENDPOINT, credential, {
      'chatgpt-account-id': accountId,
      originator: 'codeinoven',
      'user-agent': 'codeinoven'
    })
    const plan = mapChatGptPlanUsage(body)
    if (plan) {
      rateLimits.push(...plan.rateLimits)
      if (plan.credits) credits = plan.credits
      bankedResets = plan.bankedResets
    }
  }
  if (credential) {
    if (providerId === 'vercel-ai-gateway') {
      const body = await fetchJson('https://ai-gateway.vercel.sh/v1/credits', credential)
      const balance = typeof body?.['credits'] === 'number' ? body['credits'] : undefined
      if (balance !== undefined) {
        credits = { hasCredits: true, balance }
      }
    } else if (OPENCODE_ACCOUNT_PROVIDER_IDS.some((candidate) => candidate === providerId)) {
      const body = await fetchJson(OPENCODE_ACCOUNT_USAGE_ENDPOINT, credential)
      rateLimits.push(...mapOpenCodeAccountUsage(body))
    } else if (providerId === 'openrouter') {
      const body = await fetchJson('https://openrouter.ai/api/v1/key', credential)
      const data =
        body?.['data'] !== null && typeof body?.['data'] === 'object'
          ? (body['data'] as Record<string, unknown>)
          : undefined
      const total = typeof data?.['limit'] === 'number' ? data['limit'] : undefined
      const used = typeof data?.['usage'] === 'number' ? data['usage'] : undefined
      const remaining =
        typeof data?.['limit_remaining'] === 'number'
          ? data['limit_remaining']
          : total !== undefined && used !== undefined
            ? Math.max(0, total - used)
            : undefined
      if (total !== undefined && used !== undefined) {
        credits = { hasCredits: true, balance: remaining ?? Math.max(0, total - used) }
        rateLimits.push({
          id: 'pi-provider:openrouter:credits',
          label: 'Credit limit',
          usedPercent: total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0,
          ...(remaining !== undefined ? { remaining } : {}),
          limit: total
        })
      }
    }
  }

  if (rateLimits.length === 0 && !credits && !bankedResets) return null
  const usage: PiProviderUsage = {
    rateLimits,
    ...(credits ? { credits } : {}),
    ...(bankedResets ? { bankedResets } : {})
  }
  usageCache.set(cacheKey, { usage, fetchedAt: Date.now() })
  return usage
}
