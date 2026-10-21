import {
  DEFAULT_CHARS_PER_TOKEN,
  GenerationClock,
  generatedTokens,
  tokensPerSecond,
  type TokenUsageScope
} from '$shared/usage-rate'
import type { GenerationObservation } from './generation-details'

/**
 * Live tokens-per-second tracking for the message currently streaming.
 *
 * The rate is generated tokens over model-active generation time, shared with
 * the main process through {@link GenerationClock} so the live figure and the
 * persisted `generationMs` are computed the same way.
 *
 * Harnesses differ in when they report tokens: claude-code and codex report
 * counts mid-turn, pi reports them when each request ends, opencode only on its
 * per-step `step-finish` parts, and muse never reports them at all. The tracker
 * therefore consumes two independent signals: streamed output characters (every
 * harness streams those) and reported token counts when a harness has them. A
 * reported count always supersedes the character estimate for its message, and
 * the character estimate is scaled by a factor calibrated on the requests that
 * did report a count, so it converges on the provider's real tokenization.
 */
export class LiveGenerationRate {
  #clock = new GenerationClock()
  #sessionId = ''
  #messageId = $state<string | null>(null)
  #now = $state(0)
  #timer: ReturnType<typeof setInterval> | null = null
  #turnStartedAt: number | null = null
  #firstOutputAt: number | null = null
  /**
   * The newest figure this session measured. A reading is only ever replaced by
   * a newer one: between requests, while a tool runs, or before the next message
   * has streamed enough to measure, the shoe keeps showing this instead of
   * falling back to a placeholder that says nothing.
   */
  #lastRate = $state<number | null>(null)

  /** Local dispatch time, not the provider's request or inference start. */
  startTurn(at: number): void {
    if (this.#turnStartedAt === null) this.#turnStartedAt = at
  }

  observation(): GenerationObservation | undefined {
    void this.#now
    if (!this.#messageId) return undefined
    const sample = this.#clock.sample(GenerationClock.key(this.#sessionId, this.#messageId))
    if (!sample) return undefined
    return {
      ...sample,
      charsPerToken: this.charsPerToken,
      firstOutputDelayMs:
        this.#turnStartedAt !== null && this.#firstOutputAt !== null
          ? Math.max(0, this.#firstOutputAt - this.#turnStartedAt)
          : null
    }
  }

  get messageId(): string | null {
    return this.#messageId
  }

  /** Point the tracker at the session whose events it is about to receive. */
  begin(sessionId: string): void {
    if (this.#sessionId === sessionId) return
    this.clear()
    this.#sessionId = sessionId
  }

  /** Learn the model's characters-per-token factor from completed messages, so
   *  a harness that reports counts late is estimated at that model's real
   *  tokenization instead of a fixed average. */
  get charsPerToken(): number {
    return this.#clock.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  }

  /** A streamed delta appended to `partId`. */
  noteDelta(messageId: string, partId: string, chars: number): void {
    if (!messageId) return
    if (chars > 0 && this.#firstOutputAt === null) this.#firstOutputAt = Date.now()
    this.#messageId = messageId
    this.#clock.noteDelta(
      GenerationClock.key(this.#sessionId, messageId),
      Date.now(),
      partId,
      chars
    )
    this.#remember()
    this.#startTicker()
  }

  /** A part snapshot repeating its whole text; only growth counts. */
  noteSnapshot(messageId: string, partId: string, chars: number): void {
    if (!messageId) return
    if (chars > 0 && this.#firstOutputAt === null) this.#firstOutputAt = Date.now()
    this.#messageId = messageId
    this.#clock.noteSnapshot(
      GenerationClock.key(this.#sessionId, messageId),
      Date.now(),
      partId,
      chars
    )
    this.#remember()
    this.#startTicker()
  }

  /** Provider-reported generated tokens for the message so far. `scope` is what
   *  the count covers, as declared by the owning harness: a per-request count is
   *  summed across the message's requests, exactly as their windows are. */
  noteReported(messageId: string, tokens: number, scope: TokenUsageScope = 'message'): void {
    if (!messageId || tokens <= 0) return
    this.#messageId = messageId
    this.#clock.noteReported(
      GenerationClock.key(this.#sessionId, messageId),
      tokens,
      Date.now(),
      scope
    )
    this.#remember()
    this.#startTicker()
  }

  /** A request finished: close its generation window so the next one starts a
   *  fresh one and the tool wait between them is never counted. */
  completeRequest(messageId: string): void {
    if (!messageId) return
    this.#clock.completeRequest(GenerationClock.key(this.#sessionId, messageId), Date.now())
    this.#remember()
  }

  /** The session went idle: close every open window. */
  settle(): void {
    this.#clock.settleSession(this.#sessionId, Date.now())
    this.#remember()
  }

  /** Current rate for a message: the reported count when the harness gave one,
   *  otherwise the calibrated estimate from streamed characters. */
  rateFor(messageId: string): number | null {
    void this.#now
    const sample = this.#clock.sample(GenerationClock.key(this.#sessionId, messageId))
    if (!sample) return null
    return tokensPerSecond(sample, this.charsPerToken)
  }

  /** Rate of the message currently streaming, or the last one observed. */
  rate(): number | null {
    return this.#messageId ? this.rateFor(this.#messageId) : null
  }

  /**
   * The figure the shoe carries: the live reading while its window supports
   * one, and the last figure measured when it does not. A reading is replaced
   * only by a newer one, so nothing in the row has to blank back to a
   * placeholder and re-grow.
   */
  displayRate(): number | null {
    return this.rate() ?? this.#lastRate
  }

  /** Keep the newest readable figure for the display to fall back on. */
  #remember(): void {
    const live = this.rate()
    if (live !== null) this.#lastRate = live
  }

  /** Final rate for the observed message, or `null` when nothing was observed.
   *  A live estimate is only ever replaced by a real reported count. The
   *  calibration learned from this model's completed messages is kept, and so
   *  does the figure the shoe shows: a settled turn hands over to the next
   *  message with the last reading still on screen. */
  finalize(): number | null {
    const rate = this.rate()
    if (rate !== null) this.#lastRate = rate
    this.#resetWindow()
    return rate
  }

  /** Forget the session: its accounting and the figure measured in it. */
  clear(): void {
    this.#resetWindow()
    this.#lastRate = null
  }

  #resetWindow(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    this.#clock = new GenerationClock()
    this.#messageId = null
    this.#now = 0
    this.#turnStartedAt = null
    this.#firstOutputAt = null
  }

  #startTicker(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => {
      this.#now = Date.now()
    }, 1000)
  }
}

export { generatedTokens }

/**
 * Formats a generation rate for a fixed column: `40 tok/s`, and `1.4k tok/s`
 * once the figure would widen the column it sits in. The shoe sizes that column
 * to the longest plain reading it can show, so a rate past a thousand tokens a
 * second switches to the compact form rather than pushing the row wider; the
 * exact figure stays one hover away, in {@link formatTokenRateExact}.
 */
export function formatTokenRate(tokensPerSecond: number): string {
  const rate = Math.max(1, tokensPerSecond)
  if (rate < 1_000) return `${Math.round(rate).toLocaleString()} tok/s`
  const scaled = rate / 1_000
  const precision = scaled < 100 ? 1 : 0
  return `${scaled.toFixed(precision).replace(/\.0$/, '')}k tok/s`
}

/**
 * The exact rate behind a compact shoe figure, for the breakdown's own header:
 * `42.6 tok/s`, `1,431.2 tok/s`. One decimal is what the tracker measures to,
 * and rounding it further would be the app inventing precision the reading does
 * not have.
 */
export function formatTokenRateExact(tokensPerSecond: number): string {
  return `${tokensPerSecond.toLocaleString(undefined, { maximumFractionDigits: 1 })} tok/s`
}
