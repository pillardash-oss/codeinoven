import { invoke } from '$lib/ipc.svelte'
import type { BrowserCompositionPlayback, BrowserTransportCommand } from '$shared/ipc-contract'

/** How often the app asks a composition page where its playhead is. */
const POLL_MS = 250

/**
 * How long one scrub waits before the page is asked for a frame.
 *
 * A pointer moves sixty times a second and an IPC round trip does not, so a scrub
 * coalesces: one request is in flight and only the latest second is sent. The wait
 * is short enough that the picture still follows the thumb.
 */
const SCRUB_COALESCE_MS = 32

/**
 * How long one scrub request may stay unanswered.
 *
 * The page draws its own frames, so a scrub is a conversation with a document the
 * app does not own. One that never answers must give the next scrub its turn
 * rather than hold the queue for the life of the tab.
 */
const SCRUB_TIMEOUT_MS = 1000

/** The two transport commands a scrub uses: hold a frame, or move to one. */
type ScrubCommand = 'seek' | 'freeze'

/** One reader of a tab's playhead, told every time the page answers. */
export type PlayheadListener = (state: BrowserCompositionPlayback) => void

/**
 * The one playhead of one composition tab.
 *
 * The page draws its own frames and owns its own clock, so every surface that
 * shows a composition reads this answer instead of keeping one of its own: the
 * transport row above the picture, the video editor's timeline, the play button
 * and the clock labels all show the same second, because they are all the same
 * snapshot. Two independent pollers used to exist, and a surface that held a frame
 * of its own while waiting for an answer could go on showing one second while the
 * other went on moving: the seek bar froze while the timeline ran, and nothing
 * ever brought them back together.
 *
 * Three rules keep them agreeing:
 *
 * 1. One poll per tab, not one per surface, and every reader is handed the same
 *    snapshot.
 * 2. No surface holds a frame of its own. A scrub is a command, and the second the
 *    page answers with is the second everything shows: a command that fails, or
 *    answers nothing, leaves the snapshot where it was instead of pinning it to a
 *    frame that never arrives.
 * 3. Anything that plays, pauses or stops first drops a scrub still waiting to be
 *    sent, so a freeze cannot land after the play that followed it.
 *
 * Playing is never assumed either: it is whatever the page reports, which is why a
 * composition that reached its end, or whose frame threw, shows as stopped here
 * without the app deciding it.
 */
class CompositionPlayhead {
  /** The page's own answer, and the only place a playhead comes from here. */
  playback = $state.raw<BrowserCompositionPlayback | null>(null)

  /** How many surfaces are on screen reading this tab. The poll runs while > 0. */
  private leases = 0
  /**
   * How many transport commands have been sent, so an answer that belongs to an
   * older one is recognised as stale instead of being drawn as the playhead.
   *
   * A scrub is a command like any other: one that is already in flight when the
   * user plays cannot be cancelled at the page, but its answer arrives after the
   * play and would otherwise put the bar back on the frozen second the user just
   * left.
   */
  private revision = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private reading = false
  private scrubTimer: ReturnType<typeof setTimeout> | undefined
  /** The scrub waiting for its turn, or null when nothing is queued. */
  private scrub: { command: ScrubCommand; seconds: number } | null = null
  /** True while a scrub request is in flight, so only one is ever sent. */
  private scrubbing = false
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Readers hold their own state; this list is not rendered.
  private listeners = new Set<PlayheadListener>()

  constructor(readonly tabId: string) {}

  /** The second the page is on. */
  get time(): number {
    return this.playback?.time ?? 0
  }

  /** Whether the page says its playhead is moving. */
  get playing(): boolean {
    return this.playback?.playing === true
  }

  /**
   * Follow this tab while the caller is on screen.
   *
   * The listener is told every answer the poll produces, which is how a surface
   * that keeps its own fields — the editor's timeline — stays on the one playhead
   * without polling for itself. The returned function gives the tab back, and the
   * last one to leave stops the poll and forgets the snapshot: a surface that
   * left must not hand the next one a playhead from before.
   */
  attach(listener?: PlayheadListener): () => void {
    if (listener) this.listeners.add(listener)
    this.leases += 1
    this.start()
    const current = this.playback
    if (listener && current) listener(current)
    return () => {
      if (listener) this.listeners.delete(listener)
      this.leases -= 1
      if (this.leases === 0) this.stop()
    }
  }

  /**
   * Run one transport command and answer with the state it produced.
   *
   * A scrub still waiting for its turn is dropped first: it would land after this
   * command and undo it, which is exactly a freeze outliving a play.
   */
  async command(
    command: BrowserTransportCommand,
    value: number | boolean = 0
  ): Promise<BrowserCompositionPlayback | null> {
    this.dropScrub()
    this.revision += 1
    try {
      const next = await invoke('browser:transport', this.tabId, command, value)
      this.apply(next)
      return next
    } catch {
      // A tab can be closed between the click and the command. The next poll
      // reports wherever the page actually is, so nothing is assumed here.
      return null
    }
  }

  /** Move the playhead and keep whatever the page was doing with it. */
  seek(seconds: number): void {
    this.request('seek', seconds)
  }

  /** Hold the picture on one second, which is what a scrub and a frame step do. */
  hold(seconds: number): void {
    this.request('freeze', seconds)
  }

  private start(): void {
    if (this.timer !== undefined) return
    void this.read()
    this.timer = setInterval(() => void this.read(), POLL_MS)
  }

  private stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    this.dropScrub()
    // Nothing is left reading this tab, so nothing keeps a playhead for it and no
    // timer runs. The object itself stays registered: a surface that unmounts and
    // mounts again — the transport row handing over to the full screen editor — has
    // to come back to the same playhead, or the two would each poll the page and
    // two answers would be two playheads again.
    this.playback = null
    this.listeners.clear()
  }

  private async read(): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      const next = await invoke('browser:transportState', this.tabId)
      // An answer to a poll that was in flight when the last reader left is not a
      // playhead anymore: the tab has stopped being watched, and a surface that
      // attaches next must not be handed the second this one saw.
      if (this.timer !== undefined) this.apply(next)
    } catch {
      // A tab can be closed while a poll is in flight.
    } finally {
      this.reading = false
    }
  }

  private apply(next: BrowserCompositionPlayback | null): void {
    if (!next) return
    this.playback = next
    for (const listener of this.listeners) listener(next)
  }

  private request(command: ScrubCommand, seconds: number): void {
    this.scrub = { command, seconds: Number.isFinite(seconds) ? Math.max(0, seconds) : 0 }
    this.schedule()
  }

  private schedule(): void {
    if (this.scrubbing || this.scrubTimer !== undefined || !this.scrub) return
    this.scrubTimer = setTimeout(() => {
      this.scrubTimer = undefined
      void this.drain()
    }, SCRUB_COALESCE_MS)
  }

  private async drain(): Promise<void> {
    const request = this.scrub
    if (!request) return
    this.scrub = null
    this.scrubbing = true
    const revision = this.revision
    try {
      const answer = await Promise.race([
        invoke('browser:transport', this.tabId, request.command, request.seconds),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SCRUB_TIMEOUT_MS))
      ])
      // A newer scrub owns the playhead, so its answer is the one worth showing.
      // A request that answered nothing leaves the last answer standing rather
      // than pinning the bar to a frame the page never reached.
      if (revision === this.revision && !this.scrub) this.apply(answer)
    } catch {
      // A composition can close or navigate mid-scrub: the next poll settles the bar.
    } finally {
      this.scrubbing = false
      this.schedule()
    }
  }

  private dropScrub(): void {
    clearTimeout(this.scrubTimer)
    this.scrubTimer = undefined
    this.scrub = null
  }
}

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Ownership registry, not rendered state.
const playheads = new Map<string, CompositionPlayhead>()

/** The playhead of one composition tab, shared by every surface showing it. */
export function compositionPlayheadFor(tabId: string): CompositionPlayhead {
  let playhead = playheads.get(tabId)
  if (!playhead) {
    playhead = new CompositionPlayhead(tabId)
    playheads.set(tabId, playhead)
  }
  return playhead
}

export type { CompositionPlayhead }
