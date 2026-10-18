import type { AgentMessage, AgentTokenUsage, NormalizedUsage } from '$shared/types'
import {
  GENERATION_BURST_GAP_MS,
  type GenerationSample,
  type TokenUsageScope
} from '$shared/usage-rate'

export interface GenerationObservation extends GenerationSample {
  charsPerToken: number
  /** Local dispatch to first observed output, including setup and transport. */
  firstOutputDelayMs: number | null
}

export interface GenerationMessageUsage {
  harnessId?: string
  providerId?: string
  tokens?: AgentTokenUsage
  normalizedUsage?: NormalizedUsage
  tokenUsageScope?: TokenUsageScope
}

export interface GenerationFact {
  label: string
  value: string
  /** Where the value came from. It rides the row's own title, never a line. */
  source: string
}

/**
 * Who produced the measured message, named by the caller's catalogs.
 *
 * The panel draws the harness and its vendor as marks and names them in their
 * titles. A model has no mark of its own in this app   its mark is its vendor's   so
 * the model is named beside the figure while the harness and the vendor are drawn.
 */
export interface GenerationAttribution {
  harnessId?: string
  harnessName?: string
  providerId?: string
  providerName?: string
  modelLabel?: string
}

export interface GenerationDetails {
  attribution: GenerationAttribution
  /** The figure's own parts, in the order they are read: what the rate divides,
   *  then the categories the harness reported. */
  facts: GenerationFact[]
  /** How the app measured the window, for a reader checking the figure. */
  measurement: GenerationFact[]
  /** Bounded numeric fields from the harness's own usage report. */
  raw: { label: string; value: string }[]
}

const number = (value: number): string =>
  value.toLocaleString(undefined, { maximumFractionDigits: 3 })
const milliseconds = (value: number): string => `${Math.round(value).toLocaleString()} ms`

/** Bounded numeric evidence only: never expose prompt, tool payload or other strings. */
function rawNumbers(raw: Record<string, unknown>): GenerationDetails['raw'] {
  const rows: GenerationDetails['raw'] = []
  let visited = 0
  function visit(value: Record<string, unknown>, prefix: string, depth: number): void {
    for (const key of Object.keys(value).slice(0, 48)) {
      if (++visited > 96 || rows.length >= 32) return
      const item = value[key]
      const label = `${prefix}${key.slice(0, 80)}`
      if (typeof item === 'number' && Number.isFinite(item)) {
        rows.push({ label, value: String(item) })
      } else if (depth < 2 && item !== null && typeof item === 'object' && !Array.isArray(item)) {
        visit(item as Record<string, unknown>, `${label}.`, depth + 1)
      }
    }
  }
  visit(raw, '', 0)
  return rows
}

/** Build facts for the same message and generation window used by the shoe rate. */
export function generationDetails(input: {
  message?: Partial<
    Pick<
      AgentMessage,
      'harnessId' | 'providerId' | 'modelId' | 'createdAt' | 'completedAt' | 'generationMs'
    >
  > &
    GenerationMessageUsage
  observation?: GenerationObservation
  attribution?: GenerationAttribution
}): GenerationDetails {
  const { message, observation, attribution } = input
  const usage = message?.normalizedUsage
  const raw = rawNumbers(usage?.rawProviderUsage ?? {})
  const facts: GenerationFact[] = []
  const measurement: GenerationFact[] = []
  const add = (target: GenerationFact[], label: string, value: string, source: string): void => {
    target.push({ label, value, source })
  }
  const reportedTiming = (aliases: Readonly<Record<string, number>>): number | null => {
    for (const field of raw) {
      const multiplier = aliases[field.label]
      if (multiplier === undefined) continue
      const value = Number(field.value) * multiplier
      if (Number.isFinite(value) && value >= 0) return value
    }
    return null
  }
  /** One reported count covers this message or one request; the row's title says which. */
  const reported = (note: string): string =>
    message?.tokenUsageScope === 'request'
      ? `${note}; count covers one request`
      : `${note}; count covers this message`

  const ttft = reportedTiming({
    ttft_ms: 1,
    time_to_first_token_ms: 1,
    time_to_first_token_seconds: 1000,
    'stats.time_to_first_token_seconds': 1000
  })
  add(
    facts,
    'Time to first token',
    ttft === null ? 'Not reported' : milliseconds(ttft),
    'Harness reported'
  )
  if (observation?.firstOutputDelayMs != null) {
    add(
      facts,
      'First output',
      milliseconds(observation.firstOutputDelayMs),
      'App observed: dispatch to the first streamed character, including setup and transport'
    )
  }
  const generationMs = observation?.activeMs ?? message?.generationMs
  add(
    facts,
    'Streaming time',
    generationMs === undefined ? 'Unavailable' : milliseconds(generationMs),
    'App measured: model-active time only, so tool waits and thinking pauses are excluded'
  )
  const providerGeneration = reportedTiming({
    eval_duration: 0.000001,
    'timings.predicted_ms': 1,
    generation_time: 1000
  })
  if (providerGeneration !== null)
    add(facts, 'Provider generation', milliseconds(providerGeneration), 'Harness reported')
  if (observation) {
    add(
      facts,
      'Counted tokens',
      number(observation.reportedTokens ?? observation.measuredChars / observation.charsPerToken),
      observation.reportedTokens === null
        ? 'App estimate: streamed characters divided by the characters-per-token factor'
        : 'Tokens the harness reported for this message'
    )
  }
  const output = observation?.reportedTokens ?? usage?.output ?? message?.tokens?.output
  if (output != null) {
    add(
      facts,
      'Output tokens',
      number(output),
      reported(
        observation?.reportedTokens != null
          ? 'Accumulated message output; includes reasoning'
          : 'Latest harness report; includes reasoning'
      )
    )
  } else if (observation) {
    add(
      facts,
      'Output tokens (estimated)',
      number(observation.measuredChars / observation.charsPerToken),
      'App estimate from measured characters'
    )
  } else {
    add(facts, 'Output tokens', 'Not reported', 'Harness reported')
  }
  const categories: [string, string, number | null | undefined][] = [
    ['Input tokens', 'Latest harness report', usage ? usage.uncachedInput : message?.tokens?.input],
    [
      'Reasoning tokens',
      'Latest harness report; already counted in output',
      usage ? usage.reasoning : message?.tokens?.reasoning
    ],
    [
      'Cache read tokens',
      'Latest harness report; input served from the prompt cache',
      usage ? usage.cachedInput : message?.tokens?.cacheRead
    ],
    [
      'Cache write tokens',
      'Latest harness report; input written to the prompt cache',
      usage ? usage.cacheWrite : message?.tokens?.cacheWrite
    ]
  ]
  for (const [label, source, value] of categories) {
    if (value != null) add(facts, label, number(value), reported(source))
  }
  if (
    message?.createdAt !== undefined &&
    message.completedAt !== undefined &&
    message.completedAt >= message.createdAt
  ) {
    add(
      facts,
      'Message elapsed',
      milliseconds(message.completedAt - message.createdAt),
      'Message timestamps; may include tool waits and setup'
    )
  }

  if (observation) {
    add(measurement, 'Streamed characters', number(observation.chars), 'App observed on the stream')
    add(
      measurement,
      'Measured characters',
      number(observation.measuredChars),
      'App observed; only characters inside a burst long enough to time'
    )
    add(
      measurement,
      'Characters per token',
      number(observation.charsPerToken),
      'App factor, learned from the requests that reported a token count'
    )
    add(
      measurement,
      'Stream gap cutoff',
      milliseconds(GENERATION_BURST_GAP_MS),
      'A silence this long ends the generation window'
    )
    add(
      measurement,
      'Unmeasured windows',
      number(observation.unmeasuredRequests),
      'Requests that never streamed output; excluded from generation time'
    )
    add(
      measurement,
      'Measured windows',
      number(observation.requests),
      'Requests whose generation window was closed'
    )
  }

  return {
    attribution: {
      harnessId: message?.harnessId ?? attribution?.harnessId,
      harnessName: attribution?.harnessName,
      providerId: message?.providerId ?? attribution?.providerId,
      providerName: attribution?.providerName,
      modelLabel: attribution?.modelLabel ?? message?.modelId
    },
    facts,
    measurement,
    raw
  }
}
