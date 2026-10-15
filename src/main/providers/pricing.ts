import type { AgentTokenUsage } from '../../lib/types'
import { isPeakHour, peakHoursScheduleFor } from '../../lib/peak-hours'

/**
 * Per-model USD price per 1M tokens, used only to ESTIMATE cost when a harness
 * reports tokens but no dollar figure. Prices come from the live
 * `model-pricing-service` (llmpricing.dev), registered into this module's
 * in-memory registry. They are never treated as authoritative provider billing.
 */
export interface ModelPrice {
  /** Uncached input tokens, USD per 1M. */
  inputUsdPer1M: number
  /** Output tokens, USD per 1M. */
  outputUsdPer1M: number
  /** Cached (cache-read) input tokens, USD per 1M. */
  cacheReadUsdPer1M: number
  /** Cache-write tokens, USD per 1M. */
  cacheWriteUsdPer1M: number
  /** Reasoning tokens, USD per 1M. */
  reasoningUsdPer1M: number
}

/**
 * A time-of-day rate window published by an official pricing source, expressed
 * as a multiplier over the model's reference rates. DeepSeek, for example,
 * publishes one flat reference rate that IS its off-peak rate and bills double
 * inside its peak windows, so the window carries `multiplier: 2`.
 */
export interface ModelPriceWindow {
  /** Inclusive window start, UTC minutes from midnight. */
  startMinute: number
  /** Exclusive window end, UTC minutes from midnight; 1440 ends the day. */
  endMinute: number
  /** UTC days (0=Sunday … 6=Saturday) the window applies on; omitted = daily. */
  days?: readonly number[]
  /** Multiplier applied to every rate inside the window. */
  multiplier: number
  /** Human label of the window, e.g. `Peak 01:00-04:00 UTC`. */
  label: string
}

/** One registered model with its canonical `lab/model` id. */
export interface ModelPriceEntry extends ModelPrice {
  /** Full canonical id, e.g. `openai/gpt-5-2` (matched case-insensitively). */
  id: string
  /** True when `reference` was flagged as the maker's official price. */
  official?: boolean
  /** Time-of-day windows when the maker bills by hour; omitted = flat pricing. */
  windows?: readonly ModelPriceWindow[]
}

/** Rates and window an estimate was derived from, for the stored provenance. */
export interface ModelCostEstimate {
  /** Estimated USD for the token breakdown, rounded to 1e-6. */
  costUsd: number
  /** Registry id the rates came from, which may differ from the requested id. */
  entryId: string
  /** Rates actually applied, after any window multiplier. */
  rates: ModelPrice
  /** Time-of-day window that applied to the run, or null when it billed flat. */
  window: ModelPriceWindowApplication | null
  /** Version (fetch time) of the registered price snapshot, when known. */
  priceVersion: number | null
}

/** Time-of-day window resolution for one run. */
export interface ModelPriceWindowApplication {
  /** Human label of the window. */
  label: string
  /** Multiplier the window declares; 1 when the source publishes no rate for it. */
  multiplier: number
  /** False when the window matched but no source publishes rates for it. */
  rated: boolean
}

/** In-memory registry keyed by lowercased canonical `lab/model` id. */
const registry = new Map<string, ModelPriceEntry>()

/** Fetch time of the registered snapshot, or null when the loader did not say. */
let registryVersion: number | null = null

/**
 * Replace the registry contents. Called by the model-pricing service when it
 * loads the disk cache or finishes a fresh fetch. Callers stay synchronous.
 */
export function registerModelPricing(entries: ModelPriceEntry[], version?: number | null): void {
  registry.clear()
  for (const entry of entries) {
    if (entry.id && entry.id.includes('/')) registry.set(entry.id.toLowerCase(), entry)
  }
  registryVersion = version ?? null
}

/** Version (fetch time, ms) of the registered price snapshot, when known. */
export function modelPricingVersion(): number | null {
  return registryVersion
}

const clampNonNegative = (value: number): number => Math.max(0, value)

/**
 * Free-tier ids are billed at nothing by definition, so a differently named
 * paid sibling must never be used to price them. `longcat-2.5-preview-free` is
 * not `longcat-2.5-preview`, and `cline-free/deepseek-v4-flash` is not
 * `deepseek/deepseek-v4-flash`.
 */
function isFreeTierId(id: string): boolean {
  return id.split(/[/\-_:.]+/u).includes('free')
}

/**
 * Model aliases that name a family rather than a single id. Claude Code exposes
 * `haiku`, `sonnet` and `opus` as model values and the ledger records whatever
 * the harness was asked for, so a lookup by alias has to resolve to the newest
 * entry of that family in the requested lab.
 */
const FAMILY_ALIASES: Readonly<Record<string, RegExp>> = {
  haiku: /(?:^|[-_.])haiku(?:[-_.]|$)/u,
  sonnet: /(?:^|[-_.])sonnet(?:[-_.]|$)/u,
  opus: /(?:^|[-_.])opus(?:[-_.]|$)/u
}

/** Numeric run of a model name (`claude-haiku-4-5` → `[4, 5]`), for ordering. */
function versionScore(model: string): number[] {
  const run = model.match(/\d+(?:[.-]\d+)*/u)
  if (!run) return []
  return run[0].split(/[.-]/u).map((value) => Number.parseInt(value, 10))
}

function compareVersion(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Lookup forms for one requested id, most specific first. A harness records the
 * id the CLI was handed, which is often not the canonical maker id: Claude Code
 * reports `claude-fable-5[1m]`, some providers keep the dotted spelling, and
 * gateways namespace the model (`@cf/moonshotai/kimi-k2.7-code`). Rewriting a
 * free-tier id is refused outright, because its paid sibling is a different
 * product.
 */
function lookupForms(modelId: string): string[] {
  const forms: string[] = []
  const push = (value: string): void => {
    const form = value.trim().toLowerCase()
    if (form && !forms.includes(form)) forms.push(form)
  }
  const id = modelId.trim().toLowerCase()
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  for (const value of [id, bare]) {
    push(value)
    // `claude-fable-5[1m]` -> `claude-fable-5`
    push(value.replace(/\[[^\]]*\]/gu, ''))
    // `claude-haiku-5.5` -> `claude-haiku-5-5`
    push(value.replace(/\./gu, '-'))
    // `gpt-5.1-2025-11-13` -> `gpt-5.1`
    push(value.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, ''))
    push(value.replace(/\./gu, '-').replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/u, ''))
  }
  return forms
}

/**
 * Price for a free-tier id, which matches on its own name only. A free tier is
 * often the same model name under a namespace that marks it free
 * (`cline-free/deepseek-v4.1-flash`), so any lower-precision form would price
 * it as the billed model it deliberately is not.
 */
function resolveFreeTierPrice(model: string, provider: string | undefined): ModelPriceEntry | null {
  const exact = registry.get(model)
  if (exact) return exact
  let best: { entry: ModelPriceEntry; sameLab: 0 | 1 } | null = null
  for (const entry of registry.values()) {
    const slash = entry.id.indexOf('/')
    if (entry.id.slice(slash + 1) !== model) continue
    const sameLab: 0 | 1 =
      provider !== undefined && provider !== '' && entry.id.slice(0, slash) === provider ? 1 : 0
    if (!best || sameLab > best.sameLab) best = { entry, sameLab }
  }
  return best?.entry ?? null
}

interface Candidate {
  entry: ModelPriceEntry
  /** 1 when the entry's lab matches the requested provider, else 0. */
  sameLab: 0 | 1
  /** 3 exact, 2 runtime-model more specific, 1 registry-model more specific. */
  relation: 0 | 1 | 2 | 3
}

/** Best registry match for one lookup form, using the canonical id relations. */
function bestEntryForForm(form: string, provider: string | undefined): ModelPriceEntry | null {
  let best: Candidate | null = null
  for (const entry of registry.values()) {
    const slash = entry.id.indexOf('/')
    const lab = entry.id.slice(0, slash)
    const entryModel = entry.id.slice(slash + 1)
    // A free-tier entry is a different product from the paid id it resembles,
    // so a billed request never matches one.
    if (isFreeTierId(entryModel)) continue
    const sameLab = provider !== undefined && provider !== '' && lab === provider ? 1 : 0

    let relation: Candidate['relation'] = 0
    if (entryModel === form) relation = 3
    else if (form.startsWith(entryModel)) relation = 2
    else if (entryModel.startsWith(form)) relation = 1
    if (relation === 0) continue

    const candidate: Candidate = { entry, sameLab, relation }
    if (!best) {
      best = candidate
      continue
    }
    if (candidate.sameLab !== best.sameLab) {
      if (candidate.sameLab > best.sameLab) best = candidate
      continue
    }
    if (candidate.relation !== best.relation) {
      if (candidate.relation > best.relation) best = candidate
      continue
    }
    const candidateLen = candidate.entry.id.length
    const bestLen = best.entry.id.length
    if (candidateLen > bestLen || (candidateLen === bestLen && candidate.entry.official === true)) {
      best = candidate
    }
  }
  return best?.entry ?? null
}

/** Newest entry of a family alias in the requested lab, or any lab as fallback. */
function resolveFamilyAlias(alias: string, provider: string | undefined): ModelPriceEntry | null {
  const pattern = FAMILY_ALIASES[alias]
  if (!pattern) return null
  let best: { entry: ModelPriceEntry; sameLab: 0 | 1; version: number[] } | null = null
  for (const entry of registry.values()) {
    const slash = entry.id.indexOf('/')
    const model = entry.id.slice(slash + 1)
    if (!pattern.test(model)) continue
    const sameLab: 0 | 1 =
      provider !== undefined && provider !== '' && entry.id.slice(0, slash) === provider ? 1 : 0
    const version = versionScore(model)
    if (!best) {
      best = { entry, sameLab, version }
      continue
    }
    if (sameLab !== best.sameLab) {
      if (sameLab > best.sameLab) best = { entry, sameLab, version }
      continue
    }
    const order = compareVersion(version, best.version)
    if (order > 0 || (order === 0 && entry.official === true && best.entry.official !== true)) {
      best = { entry, sameLab, version }
    }
  }
  return best?.entry ?? null
}

/**
 * Resolve a runtime `(modelId, providerId)` to a price entry. Canonical
 * `lab/model` matches and their prefix relations come first, then the
 * normalized spellings of the same id, then a family alias. Returns null when
 * nothing matches (offline, unknown model, or a free tier), so a price is never
 * invented for an id no source publishes.
 */
function resolvePrice(
  modelId: string | null | undefined,
  providerId: string | null | undefined
): ModelPriceEntry | null {
  const model = modelId?.trim().toLowerCase()
  if (!model) return null
  const provider = providerId?.trim().toLowerCase()

  // A free tier has no paid sibling to fall back to, and no family to resolve
  // against: an unpriced free id stays unpriced.
  if (isFreeTierId(model)) return resolveFreeTierPrice(model, provider)

  for (const form of lookupForms(model)) {
    const entry = bestEntryForForm(form, provider)
    if (entry) return entry
  }
  return resolveFamilyAlias(model, provider)
}

/** Exported for callers that must record which entry priced a run. */
export function resolveModelPriceEntry(
  modelId: string | null | undefined,
  providerId: string | null | undefined
): ModelPriceEntry | null {
  return resolvePrice(modelId, providerId)
}

/** Scale every rate by the window's multiplier. */
function scalePrice(price: ModelPrice, multiplier: number): ModelPrice {
  if (multiplier === 1) return { ...price }
  return {
    inputUsdPer1M: price.inputUsdPer1M * multiplier,
    outputUsdPer1M: price.outputUsdPer1M * multiplier,
    cacheReadUsdPer1M: price.cacheReadUsdPer1M * multiplier,
    cacheWriteUsdPer1M: price.cacheWriteUsdPer1M * multiplier,
    reasoningUsdPer1M: price.reasoningUsdPer1M * multiplier
  }
}

/**
 * Time-of-day window that governs one run. A source-published window on the
 * entry wins; when the entry carries none, the curated peak-hours registry
 * decides. A window the source covers is authoritative, so a run outside every
 * published window bills the reference rate rather than falling through to the
 * curated schedule.
 *
 * A matched window that publishes no rate (`rated: false`) still returns its
 * label, so the record says the run landed in that window even when nothing
 * could price it.
 */
function resolveWindow(
  entry: ModelPriceEntry,
  modelId: string | null | undefined,
  providerId: string | null | undefined,
  at: Date
): ModelPriceWindowApplication | null {
  const utcMinutes = at.getUTCHours() * 60 + at.getUTCMinutes()
  const utcDay = at.getUTCDay()
  const windows = entry.windows ?? []
  for (const window of windows) {
    if (window.days && !window.days.includes(utcDay)) continue
    if (utcMinutes < window.startMinute || utcMinutes >= window.endMinute) continue
    return { label: window.label, multiplier: window.multiplier, rated: true }
  }
  if (windows.length > 0) return null

  // The schedule matches the requested id first, then the entry that priced it,
  // so a gateway-namespaced or aliased id still lands in its vendor's windows.
  const schedule =
    peakHoursScheduleFor(modelId ?? '', providerId ?? undefined) ??
    peakHoursScheduleFor(entry.id, providerId ?? undefined)
  if (!schedule || !isPeakHour(schedule, at)) return null
  return {
    label: schedule.label,
    multiplier: schedule.peakMultiplier ?? 1,
    rated: schedule.peakMultiplier !== undefined
  }
}

/**
 * Estimate a token cost in USD from a reported token breakdown when the harness
 * provides no dollar figure, together with the rates, registry version and
 * time-of-day window the number came from so the record can be audited.
 * Returns null when neither the model nor the provider has pricing data (e.g.
 * no cache and offline), so we never fabricate a number blindly.
 *
 * Codex-style totals report `input` as the cache-inclusive input count,
 * so uncached input is derived by subtracting the cached portion. A malformed
 * cache value exceeding input is clamped rather than producing a negative cost.
 */
export function estimateModelCost(
  modelId: string | null | undefined,
  providerId: string | null | undefined,
  tokens: AgentTokenUsage | undefined,
  at: Date = new Date()
): ModelCostEstimate | null {
  if (!tokens) return null
  const entry = resolvePrice(modelId, providerId)
  if (!entry) return null

  const window = resolveWindow(entry, modelId, providerId, at)
  const rates = scalePrice(entry, window?.multiplier ?? 1)
  const uncachedInput = clampNonNegative((tokens.input ?? 0) - (tokens.cacheRead ?? 0))
  const costUsd =
    (uncachedInput / 1_000_000) * rates.inputUsdPer1M +
    (clampNonNegative(tokens.cacheRead ?? 0) / 1_000_000) * rates.cacheReadUsdPer1M +
    (clampNonNegative(tokens.cacheWrite ?? 0) / 1_000_000) * rates.cacheWriteUsdPer1M +
    (clampNonNegative(tokens.output ?? 0) / 1_000_000) * rates.outputUsdPer1M +
    (clampNonNegative(tokens.reasoning ?? 0) / 1_000_000) * rates.reasoningUsdPer1M
  return {
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    entryId: entry.id,
    rates,
    window,
    priceVersion: registryVersion
  }
}

/**
 * Estimate a token cost in USD from a reported token breakdown when the harness
 * provides no dollar figure. Returns null when neither the model nor the
 * provider has pricing data. Thin wrapper over `estimateModelCost` for callers
 * that need only the number.
 */
export function estimateTokenCostUsd(
  modelId: string | null | undefined,
  providerId: string | null | undefined,
  tokens: AgentTokenUsage | undefined,
  at: Date = new Date()
): number | null {
  return estimateModelCost(modelId, providerId, tokens, at)?.costUsd ?? null
}
