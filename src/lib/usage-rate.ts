import type { AgentTokenUsage } from './types'

/**
 * Tokens-per-second accounting shared by the main process and the renderer.
 *
 * Two independent quantities have to be right before a rate means anything:
 *
 * 1. The numerator: the tokens the model actually generated. Every driver
 *    normalizes `AgentTokenUsage.output` to the provider's total generated
 *    tokens, already inclusive of `reasoning`, so the rate never adds a
 *    reasoning breakdown on top of the output that contains it. A driver
 *    declares what one count covers through
 *    `HarnessCapabilities.tokenUsageScope`, because a count that spans a whole
 *    turn or session cannot be divided by one message's window.
 * 2. The denominator: the time the model spent generating, not the wall-clock
 *    time of the turn. A turn is a sequence of requests separated by tool
 *    waits, so the honest window is the sum of each request's streaming time,
 *    which excludes both time-to-first-token and every tool wait.
 *
 * A window is a measurement only when the stream proved it was generating:
 * a burst too short to divide by, or one that delivered output faster than any
 * model can generate it (a transport flush), measures the transport rather than
 * the model. Such a window is recorded as unmeasured instead of being replaced
 * by a guess, and a rate is withheld when the measured part of the output is
 * not the part the numerator describes.
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
 * What one reported token count describes, which is what makes the division
 * meaningful.
 *
 * - `message` (default): the count covers the message it is reported on, so the
 *   message's largest report is its numerator.
 * - `request`: the count covers one request, so the counts of the requests that
 *   produced a message are summed, exactly as their generation windows are.
 * - `session`: the count is cumulative for the harness session and describes no
 *   single message, so it is never used as one message's numerator.
 */
export type TokenUsageScope = 'message' | 'request' | 'session'

/**
 * Fallback characters-per-token factor, used until a session has calibrated
 * itself. `output` covers prose and thinking, which tokenize at roughly four
 * characters per token for the models this app runs.
 */
export const DEFAULT_CHARS_PER_TOKEN = 4
/** A generation window is one contiguous burst of streamed output. A gap this
 *  long means the model stopped generating (a tool call, a retry, a new
 *  request) rather than paused mid-token, so the silence that follows a burst is
 *  never generation time, not even at a request boundary. */
export const GENERATION_BURST_GAP_MS = 2_000

/** Below this, a request's characters-per-token ratio cannot describe
 *  tokenization, so the sample is not used to calibrate the estimate. */
export const MIN_PLAUSIBLE_CHARS_PER_TOKEN = 1.5

/**
 * A burst shorter than this cannot be divided by: the stream has not shown
 * enough of the request to measure a pace, and a coalesced transport delivers a
 * whole request in a few milliseconds.
 */
export const MIN_MEASURED_BURST_MS = 250

/**
 * No model streams text faster than this. Measured across the app's own runs, a
 * real burst peaks near 1-2 characters per millisecond, so a burst ten times
 * denser is the transport flushing buffered output, not the model generating it.
 */
export const MAX_PLAUSIBLE_STREAM_CHARS_PER_SECOND = 8_000

/** Reported rates above this are artifacts, not measurements: the fastest models
 *  this app runs stream a few hundred tokens per second. */
export const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1_000

/**
 * A reported count covers the whole message while the window can only cover what
 * the stream showed. Below this share of the message's characters the two sides
 * describe different things, so no rate is reported at all.
 */
export const MIN_MEASURED_OUTPUT_SHARE = 0.5

/** One message's accumulated generation accounting. */
export interface GenerationSample {
  /** Summed streaming time of every request that produced measurable output, in ms. */
  activeMs: number
  /** Streamed output characters observed for the message. */
  chars: number
  /** Streamed characters that fell inside a measurable burst. */
  measuredChars: number
  /** Provider-reported generated tokens for the message, when the harness reports them. */
  reportedTokens: number | null
  /** Number of requests whose generation window was closed. */
  requests: number
  /** Requests that ended without a measurable window (output never streamed). */
  unmeasuredRequests: number
}

interface GenerationEntry extends GenerationSample {
  /** Start of the burst currently streaming; null between requests. */
  burstStart: number | null
  /** Arrival of the most recent output signal in the open burst. */
  lastSignalAt: number
  /** Output characters carried by the open burst. */
  burstChars: number
  /** Output signals seen in the open burst. */
  burstSignals: number
  /** Output characters already counted per part id. A snapshot repeats its
   *  part's whole text, so only the growth beyond this high-water mark is new. */
  countedByPart: Map<string, number>
  /** Reported tokens seen since the last request boundary. Drivers publish a
   *  running total for the request they are reporting, so the latest figure
   *  supersedes the earlier ones. */
  requestReportedTokens: number
  /** Scope of the counts this session reports. */
  scope: TokenUsageScope
  /** Characters and tokens already folded into the calibration. */
  learnedChars: number
  learnedTokens: number
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
 * Only a burst that carries enough of a signal to measure a pace is counted. A
 * request whose output arrived as one coalesced flush has no measurable span at
 * all; its window stays unmeasured rather than being guessed from the request's
 * own span, which would count time-to-first-token and every tool wait after the
 * last chunk as generation.
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
    this.#signal(key, at, chars, chars > 0 || partId.length > 0)
    const entry = this.#entries.get(key)
    if (!entry) return
    entry.countedByPart.set(partId, (entry.countedByPart.get(partId) ?? 0) + chars)
  }

  /** Record a part snapshot that repeats the part's whole text: only the growth
   *  past the part's high-water mark is new output, so a driver that republishes
   *  the same text (and a delta stream that already carried it) is not counted
   *  twice. */
  noteSnapshot(key: string, at: number, partId: string, chars: number): void {
    const counted = this.#entries.get(key)?.countedByPart.get(partId) ?? 0
    const growth = Math.max(0, chars - counted)
    this.#signal(key, at, growth, true)
    const entry = this.#entries.get(key)
    if (!entry) return
    entry.countedByPart.set(partId, Math.max(counted, chars))
  }

  /** Apply one output signal to the message's open burst. */
  #signal(key: string, at: number, chars: number, meaningful: boolean): void {
    if (!meaningful) return
    const entry = this.#entry(key)
    if (entry.burstStart === null) {
      entry.burstStart = at
    } else if (at - entry.lastSignalAt > GENERATION_BURST_GAP_MS) {
      this.#settleBurst(entry, entry.lastSignalAt)
      entry.burstStart = at
      entry.burstChars = 0
      entry.burstSignals = 0
    }
    entry.lastSignalAt = at
    entry.burstChars += chars
    entry.burstSignals += 1
    entry.chars += chars
  }

  /** Record the provider's generated-token count for the message so far. The
   *  value is a running total for the request being reported, so it never
   *  regresses on a reordered report, and a session-cumulative count is never
   *  attributed to one message.
   *
   *  A report is itself evidence the model was producing output, so it extends
   *  the open burst, but only while the stream is still live. A report that
   *  arrives long after the last output signal (a step's accounting delivered at
   *  its end, a cumulative `token_count` between steps) must not stretch the
   *  burst over the silence that followed generation. */
  noteReported(key: string, tokens: number, at: number, scope: TokenUsageScope = 'message'): void {
    if (tokens <= 0) return
    const entry = this.#entry(key)
    entry.scope = scope
    if (scope === 'session') return
    entry.requestReportedTokens = Math.max(entry.requestReportedTokens, tokens)
    if (entry.burstStart === null) return
    if (at - entry.lastSignalAt <= GENERATION_BURST_GAP_MS) {
      entry.lastSignalAt = Math.max(entry.lastSignalAt, at)
    }
  }

  /** Close the generation window at a request boundary.
   *
   *  `at` is the request's own end, and it only ever contributes the bounded
   *  tail a model could still have been generating after its last chunk: a
   *  request that finished minutes after its output did (a tool ran in between)
   *  must not hand that wait to the denominator, which is what made a fast
   *  answer read as a fraction of a token per second. */
  completeRequest(key: string, at: number): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    if (entry.burstStart !== null) {
      this.#settleBurst(entry, at)
      entry.burstStart = null
      entry.burstChars = 0
      entry.burstSignals = 0
    }
    if (entry.requestReportedTokens > 0) {
      entry.reportedTokens =
        entry.scope === 'request'
          ? (entry.reportedTokens ?? 0) + entry.requestReportedTokens
          : Math.max(entry.reportedTokens ?? 0, entry.requestReportedTokens)
    }
    entry.requestReportedTokens = 0
    entry.requests += 1
    this.#learn(key)
  }

  /** Count a finished burst as generation time, or leave it unmeasured. */
  #settleBurst(entry: GenerationEntry, at: number): void {
    // The tail between the last chunk and the request's own end is generation
    // only while it stays inside one burst gap; beyond that the model had
    // stopped producing output.
    const end = Math.min(at, entry.lastSignalAt + GENERATION_BURST_GAP_MS)
    const spanMs = Math.max(0, end - (entry.burstStart ?? end))
    if (entry.burstSignals < 2 || spanMs < MIN_MEASURED_BURST_MS) {
      entry.unmeasuredRequests += 1
      return
    }
    if (entry.burstChars / spanMs > MAX_PLAUSIBLE_STREAM_CHARS_PER_SECOND / 1000) {
      // Denser than any model can stream: the transport buffered the output and
      // released it at once, so this span measures the flush, not the model.
      entry.unmeasuredRequests += 1
      return
    }
    entry.activeMs += spanMs
    entry.measuredChars += entry.burstChars
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

  /** Current accounting for a message, including the burst still streaming.
   *
   *  The open burst is read the same way a closed one is, so a reader can never
   *  turn a stream that has gone quiet into generation time: the tail it can
   *  contribute is bounded by one burst gap. */
  sample(key: string, at = Date.now()): GenerationSample | null {
    const entry = this.#entries.get(key)
    if (!entry) return null
    let activeMs = entry.activeMs
    let measuredChars = entry.measuredChars
    if (entry.burstStart !== null) {
      const end = Math.min(at, entry.lastSignalAt + GENERATION_BURST_GAP_MS)
      const spanMs = Math.max(0, end - entry.burstStart)
      const plausible =
        entry.burstSignals >= 2 &&
        spanMs >= MIN_MEASURED_BURST_MS &&
        entry.burstChars / Math.max(1, spanMs) <= MAX_PLAUSIBLE_STREAM_CHARS_PER_SECOND / 1000
      if (plausible) {
        activeMs += spanMs
        measuredChars += entry.burstChars
      }
    }
    return {
      activeMs,
      chars: entry.chars,
      measuredChars,
      reportedTokens: entry.reportedTokens,
      requests: entry.requests,
      unmeasuredRequests: entry.unmeasuredRequests
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
      measuredChars: 0,
      reportedTokens: null,
      requests: 0,
      unmeasuredRequests: 0,
      burstStart: null,
      lastSignalAt: 0,
      burstChars: 0,
      burstSignals: 0,
      countedByPart: new Map(),
      requestReportedTokens: 0,
      scope: 'message',
      learnedChars: 0,
      learnedTokens: 0
    }
    this.#entries.set(key, created)
    return created
  }

  /** Learn the characters-per-token ratio of what this request actually
   *  streamed and reported, so a harness that reports counts late is still
   *  estimated at its own tokenization.
   *
   *  A ratio below {@link MIN_PLAUSIBLE_CHARS_PER_TOKEN} cannot describe
   *  tokenization: it means the provider counted output the stream does not
   *  carry (tool-call accounting on some gateways). Folded in, such a sample
   *  would drag the factor down and make every later estimate too high, so it is
   *  skipped instead. */
  #learn(key: string): void {
    const entry = this.#entries.get(key)
    if (!entry) return
    const charsDelta = entry.chars - entry.learnedChars
    const tokensDelta = (entry.reportedTokens ?? 0) - entry.learnedTokens
    entry.learnedChars = entry.chars
    entry.learnedTokens = entry.reportedTokens ?? 0
    if (charsDelta <= 0 || tokensDelta <= 0) return
    if (charsDelta / tokensDelta < MIN_PLAUSIBLE_CHARS_PER_TOKEN) return
    this.#calibrationChars += charsDelta
    this.#calibrationTokens += tokensDelta
  }
}

/**
 * Tokens generated per second over a message's measured generation window, or
 * `null` when no honest rate can be derived from what was observed.
 *
 * A rate is withheld when nothing measurable streamed, when the reported count
 * covers output the window does not (the measured bursts carried less than
 * {@link MIN_MEASURED_OUTPUT_SHARE} of the streamed characters), and when the
 * result exceeds what any model generates. `charsPerToken` is the session's
 * calibrated factor, used only when the harness reported no token counts.
 */
export function tokensPerSecond(
  sample: Pick<GenerationSample, 'activeMs' | 'chars' | 'measuredChars' | 'reportedTokens'>,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN
): number | null {
  if (sample.activeMs <= 0) return null
  const reported = sample.reportedTokens
  if (reported !== null && !windowCoversOutput(sample)) return null
  const generated =
    reported ?? (sample.measuredChars > 0 ? sample.measuredChars / Math.max(0.5, charsPerToken) : 0)
  if (generated <= 0) return null
  const rate = generated / (sample.activeMs / 1000)
  return rate <= MAX_PLAUSIBLE_TOKENS_PER_SECOND ? rate : null
}

/**
 * True when the sample's measured bursts carried enough of the message's
 * streamed output for a count that covers the whole message to be divided by
 * them. A message whose output arrived mostly as buffered flushes has no window
 * worth dividing by, and reporting one would overstate the pace the user saw.
 */
export function windowCoversOutput(
  sample: Pick<GenerationSample, 'chars' | 'measuredChars'>
): boolean {
  if (sample.chars <= 0) return true
  return sample.measuredChars / sample.chars >= MIN_MEASURED_OUTPUT_SHARE
}

/**
 * Rate for a window recorded on a message (`generationMs`), which the clock
 * already measured when the turn ran. Only the plausibility ceiling applies: the
 * recorded window was accepted by exactly the same rules at the time.
 */
export function recordedTokenRate(generated: number, generationMs: number): number | null {
  if (generated <= 0 || generationMs <= 0) return null
  const rate = generated / (generationMs / 1000)
  return rate <= MAX_PLAUSIBLE_TOKENS_PER_SECOND ? rate : null
}
