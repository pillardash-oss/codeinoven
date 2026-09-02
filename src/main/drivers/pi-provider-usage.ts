import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { AgentRateLimitWindow, AgentUsageCredits } from '../../lib/types'
import { Logger } from '../system/logger'

/**
 * On-demand prepaid-credit balances for pi's gateway providers. Pi stores
 * provider auth in `~/.pi/agent/auth.json`; the gateways that expose a
 * credit-balance endpoint are probed with the stored credential so the
 * battery popover can show "how much is left" the same way codex/claude-code
 * report plan balances. Providers without a known endpoint return null.
 */

interface PiAuthEntry {
  type?: unknown
  key?: unknown
  access?: unknown
}

const CREDITS_TIMEOUT_MS = 5_000
const CREDITS_CACHE_TTL_MS = 60_000

interface PiProviderUsage {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
}

interface CachedUsage {
  usage: PiProviderUsage
  fetchedAt: number
}

const usageCache = new Map<string, CachedUsage>()

function piAuthPath(): string {
  return join(homedir(), '.pi', 'agent', 'auth.json')
}

async function piAuthEntry(providerId: string): Promise<PiAuthEntry | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(piAuthPath(), 'utf8'))
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

async function fetchJson(url: string, credential: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${credential}` },
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
 * 60s per provider so repeated battery hovers never hammer gateway endpoints.
 * Unknown providers resolve to null — the popover simply omits provider usage.
 */
export async function fetchPiProviderUsage(
  providerId: string | undefined
): Promise<PiProviderUsage | null> {
  if (!providerId) return null
  const cached = usageCache.get(providerId)
  if (cached && Date.now() - cached.fetchedAt < CREDITS_CACHE_TTL_MS) return cached.usage

  let credits: AgentUsageCredits | null = null
  const rateLimits: AgentRateLimitWindow[] = []
  const entry = await piAuthEntry(providerId)
  const credential = entry ? credentialValue(entry) : undefined
  if (credential) {
    if (providerId === 'vercel-ai-gateway') {
      const body = await fetchJson('https://ai-gateway.vercel.sh/v1/credits', credential)
      const balance = typeof body?.['credits'] === 'number' ? body['credits'] : undefined
      if (balance !== undefined) {
        credits = { hasCredits: true, balance }
      }
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

  if (rateLimits.length === 0 && !credits) return null
  const usage: PiProviderUsage = {
    rateLimits,
    ...(credits ? { credits } : {})
  }
  usageCache.set(providerId, { usage, fetchedAt: Date.now() })
  return usage
}
