import {
  DEFAULT_CHARS_PER_TOKEN,
  GenerationClock,
  generatedTokens,
  tokensPerSecond
} from '$shared/usage-rate'

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
    this.#messageId = messageId
    this.#clock.noteDelta(
      GenerationClock.key(this.#sessionId, messageId),
      Date.now(),
      partId,
      chars
    )
    this.#startTicker()
  }

  /** A part snapshot repeating its whole text; only growth counts. */
  noteSnapshot(messageId: string, partId: string, chars: number): void {
    if (!messageId) return
    this.#messageId = messageId
    this.#clock.noteSnapshot(
      GenerationClock.key(this.#sessionId, messageId),
      Date.now(),
      partId,
      chars
    )
    this.#startTicker()
  }

  /** Provider-reported generated tokens for the message so far. */
  noteReported(messageId: string, tokens: number): void {
    if (!messageId || tokens <= 0) return
    this.#messageId = messageId
    this.#clock.noteReported(GenerationClock.key(this.#sessionId, messageId), tokens, Date.now())
    this.#startTicker()
  }

  /** A request finished: close its generation window so the next one starts a
   *  fresh one and the tool wait between them is never counted. */
  completeRequest(messageId: string): void {
    if (!messageId) return
    this.#clock.completeRequest(GenerationClock.key(this.#sessionId, messageId), Date.now())
  }

  /** The session went idle: close every open window. */
  settle(): void {
    this.#clock.settleSession(this.#sessionId, Date.now())
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

  /** Final rate for the observed message, or `null` when nothing was observed.
   *  A live estimate is only ever replaced by a real reported count. The
   *  calibration learned from this model's completed messages is kept. */
  finalize(): number | null {
    const rate = this.rate()
    this.#resetWindow()
    return rate
  }

  clear(): void {
    this.#resetWindow()
  }

  #resetWindow(): void {
    if (this.#timer) {
      clearInterval(this.#timer)
      this.#timer = null
    }
    this.#clock = new GenerationClock()
    this.#messageId = null
    this.#now = 0
  }

  #startTicker(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => {
      this.#now = Date.now()
    }, 1000)
  }
}

export { generatedTokens }

/** Formats a generation rate as e.g. `40 tok/s` (grouped: `1,234 tok/s`). */
export function formatTokenRate(tokensPerSecond: number): string {
  return `${Math.max(1, Math.round(tokensPerSecond)).toLocaleString()} tok/s`
}
