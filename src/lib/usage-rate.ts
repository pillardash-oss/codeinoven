import type { AgentTokenUsage } from './types'

/**
 * Tokens-per-second accounting shared by the main process and the renderer.
 *
 * Two independent quantities have to be right before a rate means anything:
 *
 * 1. The numerator: the tokens the model actually generated. Every driver
 *    normalizes `AgentTokenUsage.output` to the provider's total generated
 *    tokens, already inclusive of `reasoning`, so the rate never adds a
 *    reasoning breakdown on top of the output that contains it.
 * 2. The denominator: the time the model spent generating, not the wall-clock
 *    time of the turn. A turn is a sequence of requests separated by tool
 *    waits, so the honest window is the sum of each request's streaming time,
 *    which excludes both time-to-first-token and every tool wait.
 *
 * A harness that reports no token counts gets a rate from the streamed output
 * characters scaled by a characters-to-tokens factor calibrated on that same
 * model's completed messages. That estimate is always replaced by the reported
 * figure as soon as a request reports one.
 */

/** Generated tokens are `output`; `reasoning` is a subset of it for the
 *  providers that report the breakdown, and is folded into `output` by the
 *  mappers for the providers that report it separately. */
export function generatedTokens(tokens?: AgentTokenUsage | null): number {
  if (!tokens) return 0
  return Math.max(0, tokens.output ?? 0)
}

/**
 * Fallback characters-per-token factor, used until a session has calibrated
 * itself. `output` covers prose and thinking, which tokenize at roughly four
 * characters per token for the models this app runs.
 */
export const DEFAULT_CHARS_PER_TOKEN = 4
/** A generation window is one contiguous burst of streamed output. A gap this
 *  long means the model stopped generating (a tool call, a retry, a new
 *  request) rather than paused mid-token. */
export const GENERATION_BURST_GAP_MS = 2_000

/** Below this, a request's characters-per-token ratio cannot describe
 *  tokenization, so the sample is not used to calibrate the estimate. */
export const MIN_PLAUSIBLE_CHARS_PER_TOKEN = 1.5

/**
 * A request's output burst normally runs to its completion: measured over 161
 * real pi requests the burst covered the whole signal-to-completion span for the
 * median request and at least 72% of it at the 10th percentile, with only ~8%
 * below half. A burst far shorter than the request therefore means the transport
 * coalesced the chunks, and that shortened burst would report a meaningless rate,
 * so the request's own span is used instead.
 */
export const BUFFERED_STREAM_MIN_SHARE = 0.5

/** One message's accumulated generation accounting. */
export interface GenerationSample {
  /** Summed streaming time of every request that produced output, in ms. */
  activeMs: number
  /** Streamed output characters observed for the message. */
  chars: number
  /** Provider-reported generated tokens, when the harness reports them. */
  reportedTokens: number | null
  /** Number of requests whose generation window was closed. */
  requests: number
}

interface GenerationEntry extends GenerationSample {
  /** Start of the burst currently streaming; null between requests. */
  burstStart: number | null
  /** Arrival of the most recent output signal in the open burst. */
  lastSignalAt: number
  /** Output characters already counted per part id. A snapshot repeats its
   *  part's whole text, so only the growth beyond this high-water mark is new. */
  countedByPart: Map<string, number>
}

/**
 * Accumulates the model-active generation time of one message across every
 * request that produced it.
 *
 * The stream is the only clock available: no harness reports a generation
 * duration. Output signals (a delta, or a part snapshot that grew) open and
 * extend a burst; a gap longer than {@link GENERATION_BURST_GAP_MS} closes it,
 * so tool waits between requests are excluded, and `completeRequest` closes the
 * burst at a request boundary so the next request starts a fresh window.
 *
 * A request whose output arrived as a single coalesced burst has no measurable
 * streaming span, so its window falls back to the request's own span, which
 * includes time-to-first-token.
 */
export class GenerationClock {
  #entries = new Map<string, GenerationEntry>()
  #calibrationChars = 0
  #calibrationTokens = 0

  /** Address one message's accounting. Message ids are unique per session, but
   *  a composite key keeps two sessions that ever reuse an id apart. */
  static key(sessionId: string, messageId: string): string {
    return `${sessionId}\u0000${messageId}`
  }

  /** Record a streamed delta of `chars` characters appended to `partId`. */
  noteDelta(key: string, at: number, partId: string, chars: number): void {
    const entry = this.#open(key, at, chars > 0 || partId.length > 0)
    if (!entry) return
    entry.chars += chars
    entry.countedByPart.set(partId, (entry.countedByPart.get(partId) ?? 0) + chars)
  }

  /** Record a part snapshot that repeats the part's whole text: only the growth
   *  past the part's high-water mark is new output, so a driver that republishes
   *  the same text (and a delta stream that already carried it) is not counted
   *  twice. */
  noteSnapshot(key: string, at: number, partId: string, chars: number): void {
    const entry = this.#open(key, at, true)
    if (!entry) return
    const counted = entry.countedByPart.get(partId) ?? 0
    entry.chars += Math.max(0, chars - counted)
    entry.countedByPart.set(partId, Math.max(counted, chars))
  }

  /** Record the provider's generated-token count for the message so far. The
   *  value is a running total, so it never regresses on a reordered report.
   *
   *  A report is itself evidence the model was producing output, so it extends
   *  the open burst, but only while the stream is still live. A report that
   *  arrives long after the last output signal (a step's accounting delivered at
   *  its end, a cumulative `token_count` between steps) must not stretch the
   *  burst over the silence that followed generation. */
  noteReported(key: string, tokens: number, at: number): void {
    if (tokens <= 0) return
    const entry = this.#entry(key)
    entry.reportedTokens = Math.max(entry.reportedTokens ?? 0, tokens)
    if (entry.burstStart === null) return
    if (at - entry.lastSignalAt <= GENERATION_BURST_GAP_MS) {
      entry.lastSignalAt = Math.max(entry.lastSignalAt, at)
    }
  }

  /** Close the generation window at a request boundary. */
  completeRequest(key: string, at: number): void {
    const entry = this.#entries.get(key)
    if (!entry || entry.burstStart === null) return
    // A burst that never saw a second signal has no measurable span at all, and
    // a coalesced one is too short to divide by; both fall back to the request's
    // own span, which includes time-to-first-token but cannot be collapsed by
    // the transport. See BUFFERED_STREAM_MIN_SHARE for the measurement that
    // decides this.
    const requestMs = Math.max(0, at - entry.burstStart)
    const burstMs = Math.max(0, entry.lastSignalAt - entry.burstStart)
    entry.activeMs += burstMs >= requestMs * BUFFERED_STREAM_MIN_SHARE ? burstMs : requestMs
    entry.burstStart = null
    entry.requests += 1
    this.#learn(key)
  }

  /**
   * Characters per token observed across this session, learned from every
   * request that paired a reported token count with the characters actually
   * streamed for it. Summed rather than averaged, so a long request weighs what
   * it is worth. `null` until a harness reports a count; a harness that never
   * reports one keeps the caller's default.
   */
  get charsPerToken(): number | null {
    if (this.#calibrationChars <= 0 || this.#calibrationTokens <= 0) return null
    return this.#calibrationChars / this.#calibrationTokens
  }

  /** Current accounting for a message, including the burst still streaming. */
  sample(key: string, at = Date.now()): GenerationSample | null {
    const entry = this.#entries.get(key)
    if (!entry) return null
    const openMs =
      entry.burstStart === null
        ? 0
        : Math.max(
            0,
            (entry.lastSignalAt > entry.burstStart ? entry.lastSignalAt : at) - entry.burstStart
          )
    return {
      activeMs: entry.activeMs + openMs,
      chars: entry.chars,
      reportedTokens: entry.reportedTokens,
      requests: entry.requests
    }
  }

  /** Forget every message of a session. */
  dropSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#entries.delete(key)
    }
  }

  /** Close every open burst of a session at its idle boundary. */
  settleSession(sessionId: string, at: number): void {
    const prefix = `${sessionId}\u0000`
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.completeRequest(key, at)
    }
  }

  #entry(key: string): GenerationEntry {
    const existing = this.#entries.get(key)
    if (existing) return existing
    const created: GenerationEntry = {
      activeMs: 0,
      chars: 0,
      reportedTokens: null,
      requests: 0,
      burstStart: null,
      lastSignalAt: 0,
      countedByPart: new Map()
    }
    this.#entries.set(key, created)
    return created
  }

  #closeBurst(entry: GenerationEntry): void {
    if (entry.burstStart === null) return
    entry.activeMs += Math.max(0, entry.lastSignalAt - entry.burstStart)
    entry.burstStart = null
  }

  /** Apply one output signal to the entry's burst, opening or splitting it.
   *  Returns null when the signal carries no output worth recording. */
  #open(key: string, at: number, meaningful: boolean): GenerationEntry | null {
    if (!meaningful) return null
    const entry = this.#entry(key)
    if (entry.burstStart === null) {
      entry.burstStart = at
    } else if (at - entry.lastSignalAt > GENERATION_BURST_GAP_MS) {
      this.#closeBurst(entry)
      entry.burstStart = at
    }
    entry.lastSignalAt = at
    return entry
  }

  /** Learn this request's characters-per-token ratio, when it reported tokens.
   *
   *  A ratio below {@link MIN_PLAUSIBLE_CHARS_PER_TOKEN} cannot describe
   *  tokenization: it means the provider counted output the stream does not
   *  carry (tool-call accounting on some gateways). Folded in, such a sample
   *  would drag the factor down and make every later estimate too high, so it is
   *  skipped instead. */
  #learn(key: string): void {
    const entry = this.#entries.get(key)
    if (!entry || entry.chars <= 0) return
    const tokens = entry.reportedTokens ?? 0
    if (tokens <= 0) return
    if (entry.chars / tokens < MIN_PLAUSIBLE_CHARS_PER_TOKEN) return
    this.#calibrationChars += entry.chars
    this.#calibrationTokens += tokens
  }
}

/**
 * Tokens generated per second over a generation window, or `null` when the
 * window is too small to divide by. `charsPerToken` is the session's calibrated
 * factor, used only when the harness reported no token counts.
 */
export function tokensPerSecond(
  sample: Pick<GenerationSample, 'activeMs' | 'chars' | 'reportedTokens'>,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN
): number | null {
  if (sample.activeMs <= 0) return null
  const generated =
    sample.reportedTokens ?? (sample.chars > 0 ? sample.chars / Math.max(0.5, charsPerToken) : 0)
  if (generated <= 0) return null
  return generated / (sample.activeMs / 1000)
}
