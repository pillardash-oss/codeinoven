import { spawn } from 'child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentRateLimitWindow, AgentUsageCredits } from '../../lib/types'
import { buildProcessEnvironment, resolveExecutablePath } from '../drivers/cli-environment'

const OPENUSAGE_API_BASE = 'http://127.0.0.1:6736/v1/limits'
const OPENUSAGE_SCHEMA = 'openusage.limits.v1'
const OPENUSAGE_TIMEOUT_MS = 8_000
const OPENUSAGE_CACHE_MS = 30_000

interface OpenUsageTelemetry {
  rateLimits: AgentRateLimitWindow[]
  credits?: AgentUsageCredits
}

interface CachedTelemetry {
  expiresAt: number
  value: OpenUsageTelemetry | null
}

const PROVIDER_BY_HARNESS: Readonly<Record<string, string>> = {
  antigravity: 'antigravity',
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode'
}

const RESOURCE_LABELS: Readonly<Record<string, string>> = {
  session: 'Session',
  weekly: 'Weekly',
  monthly: 'Monthly',
  geminiSession: 'Gemini session',
  geminiWeekly: 'Gemini weekly',
  nonGeminiSession: 'Claude and GPT-OSS session',
  nonGeminiWeekly: 'Claude and GPT-OSS weekly',
  sonnet: 'Sonnet weekly',
  fable: 'Fable weekly',
  spark: 'Spark session',
  sparkWeekly: 'Spark weekly'
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function titleCase(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replaceAll('_', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function epochMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseProviderTelemetry(value: unknown, providerId: string): OpenUsageTelemetry | null {
  const envelope = record(value)
  if (envelope?.['schema'] !== OPENUSAGE_SCHEMA) return null
  const providers = record(envelope['providers'])
  if (!providers) return null
  const matchingProviders = Object.entries(providers)
    .filter(([id]) => id === providerId || id.startsWith(`${providerId}:`))
    .map(([, provider]) => record(provider))
    .filter((provider): provider is Record<string, unknown> => provider !== null)
  if (matchingProviders.length === 0) return null

  const rateLimits: AgentRateLimitWindow[] = []
  let credits: AgentUsageCredits | undefined
  for (const [providerIndex, provider] of matchingProviders.entries()) {
    const resources = record(provider['resources'])
    if (!resources) continue
    for (const [resourceId, rawResource] of Object.entries(resources)) {
      const resource = record(rawResource)
      if (!resource) continue
      const kind = resource['kind']
      if (kind === 'consumption') {
        const used = finiteNumber(resource['used'])
        const limit = finiteNumber(resource['limit'])
        const remaining = finiteNumber(resource['remaining'])
        const utilization = finiteNumber(resource['utilization'])
        const resetsAt = epochMilliseconds(resource['resetsAt'])
        const windowSeconds = finiteNumber(resource['windowSeconds'])
        if (
          used === undefined &&
          remaining === undefined &&
          utilization === undefined &&
          resetsAt === undefined
        ) {
          continue
        }
        rateLimits.push({
          id: `openusage:${providerId}:${providerIndex}:${resourceId}`,
          label: RESOURCE_LABELS[resourceId] ?? titleCase(resourceId),
          ...(utilization === undefined
            ? used !== undefined && limit !== undefined && limit > 0
              ? { usedPercent: Math.max(0, Math.min(100, (used / limit) * 100)) }
              : {}
            : { usedPercent: Math.max(0, Math.min(100, utilization * 100)) }),
          ...(remaining === undefined ? {} : { remaining }),
          ...(limit === undefined ? {} : { limit }),
          ...(resetsAt === undefined ? {} : { resetsAt }),
          ...(windowSeconds === undefined ? {} : { windowMinutes: windowSeconds / 60 })
        })
        continue
      }

      if (kind !== 'balance') continue
      const available = finiteNumber(resource['available'])
      if (available === undefined) continue
      const unit = typeof resource['unit'] === 'string' ? resource['unit'].toLocaleLowerCase() : ''
      credits = {
        hasCredits: true,
        ...(unit === 'usd' ? { balance: available } : {}),
        planType: typeof provider['plan'] === 'string' ? provider['plan'] : 'openusage'
      }
    }
  }

  return rateLimits.length > 0 || credits ? { rateLimits, ...(credits ? { credits } : {}) } : null
}

async function openUsageExecutable(): Promise<string | undefined> {
  const env = buildProcessEnvironment()
  const onPath = resolveExecutablePath('openusage', env)
  if (onPath) return onPath
  const bundledHelpers = [
    '/Applications/OpenUsage.app/Contents/Helpers/openusage',
    join(homedir(), 'Applications', 'OpenUsage.app', 'Contents', 'Helpers', 'openusage')
  ]
  for (const candidate of bundledHelpers) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to the next standard app location.
    }
  }
  return undefined
}

async function readOpenUsageCli(providerId: string): Promise<unknown> {
  const executable = await openUsageExecutable()
  if (!executable) return null
  return new Promise((resolve) => {
    const child = spawn(executable, [providerId], {
      env: buildProcessEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let stdout = ''
    let settled = false
    const finish = (value: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, OPENUSAGE_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 2_000_000) {
        child.kill()
        finish(null)
      }
    })
    child.on('error', () => finish(null))
    child.on('exit', (code) => {
      if (code !== 0) return finish(null)
      try {
        finish(JSON.parse(stdout) as unknown)
      } catch {
        finish(null)
      }
    })
  })
}

export class OpenUsageClient {
  private readonly cache = new Map<string, CachedTelemetry>()
  private readonly inflight = new Map<string, Promise<OpenUsageTelemetry | null>>()

  async readHarnessUsage(harnessId: string): Promise<OpenUsageTelemetry | null> {
    const providerId = PROVIDER_BY_HARNESS[harnessId]
    if (!providerId) return null
    const cached = this.cache.get(providerId)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const existing = this.inflight.get(providerId)
    if (existing) return existing

    const request = this.fetchProvider(providerId).finally(() => this.inflight.delete(providerId))
    this.inflight.set(providerId, request)
    return request
  }

  private async fetchProvider(providerId: string): Promise<OpenUsageTelemetry | null> {
    let payload: unknown = null
    try {
      const response = await fetch(`${OPENUSAGE_API_BASE}/${encodeURIComponent(providerId)}`, {
        signal: AbortSignal.timeout(1_000)
      })
      if (response.ok) payload = (await response.json()) as unknown
    } catch {
      // The menu-bar app is optional; fall through to the documented one-shot CLI.
    }
    payload ??= await readOpenUsageCli(providerId)
    const value = parseProviderTelemetry(payload, providerId)
    this.cache.set(providerId, { expiresAt: Date.now() + OPENUSAGE_CACHE_MS, value })
    return value
  }
}
