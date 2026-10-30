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

/**
 * How long a playhead survives the surface that was watching it.
 *
 * The editor and the player window are two surfaces on one tab, and moving between
 * them tears one down before the other has mounted. That gap is a moment, so the
 * last answer is kept for a while rather than for the life of the process: a tab
 * reopened minutes later starts wherever its page is, not where the user left it.
 */
const HANDOFF_WINDOW_MS = 60_000

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

  /**
   * The last answer the page gave, kept across a surface change.
   *
   * A composition is watched in more than one window: the editor holds the picture,
   * and the player window is opened on the same tab. The page keeps its own clock
   * while the surface changes, but a page that is re-armed comes back at zero, and a
   * viewer who asked to watch full screen expects the film to carry on from the
   * second they left, not to start again. This is what the next surface restores.
   */
  private remembered: { time: number; playing: boolean; at: number } | null = null
  /** True on the first answer after a surface change, so the handoff runs once. */
  private handingOver = false

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
    const before = this.playback
    // The bar is drawn before the page answers, because the app is the one that was
    // asked: a play button that shows "play" until a document somewhere else confirms
    // it is a button that looks broken whenever that document is slow or mute. The
    // page's answer still wins when it carries one, and a reset is corrected below.
    const expected = this.expected(before, command, value)
    if (expected) this.apply(expected)
    try {
      const next = await invoke('browser:transport', this.tabId, command, value)
      if (next && this.rearmedUnderneath(before, next, command)) return this.playback
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
    this.handingOver = this.remembered !== null
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

  /**
   * Repairs made since an answer last arrived, and when the last one was made.
   *
   * A composition's transport lives inside the page, and a page can lose it: a
   * reload that outlived the install, a replaced document, a runtime the page threw
   * away. Every read then answers nothing, which is a transport row stuck at zero
   * beside a picture drawing its own frames. Bounded, because a page that keeps
   * refusing must not be re-armed four times a second.
   */
  private revivals = 0
  private revivedAt = 0

  private async read(): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      const next = await invoke('browser:transportState', this.tabId).catch(() => null)
      if (next) this.revivals = 0
      else this.revive()
      // An answer to a poll that was in flight when the last reader left is not a
      // playhead anymore: the tab has stopped being watched, and a surface that
      // attaches next must not be handed the second this one saw.
      if (this.timer !== undefined) await this.handOver(next)
    } catch {
      // A tab can be closed while a poll is in flight.
    } finally {
      this.reading = false
    }
  }

  /**
   * Take the page's first answer after a surface change, restoring the film first.
   *
   * A page that kept its clock is already where the user left it, and its answer is
   * the truth. A page that was re-armed comes back at the start, which is the one
   * case where the app knows better: the second and the run the last surface showed
   * are handed back to it, so the picture, the seek bar and the play button agree
   * from the first frame of the new surface.
   */
  private async handOver(next: BrowserCompositionPlayback | null): Promise<void> {
    if (!this.handingOver || !next) {
      this.handingOver = false
      this.apply(next)
      return
    }
    this.handingOver = false
    const remembered = this.remembered
    if (!remembered || Date.now() - remembered.at > HANDOFF_WINDOW_MS || remembered.time <= 0.25) {
      this.apply(next)
      return
    }
    if (next.time >= remembered.time - 0.25) {
      this.apply(next)
      return
    }
    this.apply({ ...next, time: remembered.time, playing: remembered.playing })
    // The seek is awaited before the play, because a play drops any scrub still
    // waiting for its turn: the order is the difference between the film carrying on
    // from the second the user left and it carrying on from zero.
    await this.command('seek', remembered.time)
    if (remembered.playing && !next.playing) await this.command('play')
  }

  /**
   * Ask the page to arm itself again, and take the answer as the playhead.
   *
   * A transport command is what re-arms an unarmed document in main, so one pause is
   * both the repair and the read: it cannot start a video the user did not start, and
   * its answer is what the bar has been missing.
   */
  private revive(): void {
    if (this.revivals >= 3) return
    if (Date.now() - this.revivedAt < 2000) return
    this.revivals += 1
    this.revivedAt = Date.now()
    void this.command('pause')
  }

  /**
   * The state a command is about to produce, from the state it was given.
   *
   * Play, pause and stop move the run flag; a seek moves the second. This is what the
   * bar shows while the page is answering, so the controls follow the user's press
   * rather than waiting on a document that may not answer at all.
   */
  private expected(
    before: BrowserCompositionPlayback | null,
    command: BrowserTransportCommand,
    value: number | boolean
  ): BrowserCompositionPlayback | null {
    if (!before) return null
    const playing = before.playing
    switch (command) {
      case 'play':
        return playing ? null : { ...before, playing: true }
      case 'pause':
        return playing ? { ...before, playing: false } : null
      case 'toggle':
        return { ...before, playing: !playing }
      case 'stop':
        return playing || before.time !== 0 ? { ...before, playing: false, time: 0 } : null
      case 'seek':
        return typeof value === 'number' ? { ...before, time: Math.max(0, value) } : null
      default:
        return null
    }
  }

  /**
   * Whether a command's answer is a document that came back at the start.
   *
   * A composition that lost its runtime is armed again by the next command, and
   * arming draws the first frame and answers with zero. The command that triggered it
   * was about the second the user was on, not about the start, so the answer is
   * corrected to that second and the page is put back on it: pressing pause while
   * annotating must not send the seek head to zero, and closing the annotation must
   * not leave it there while the picture sits on the frame the user chose.
   *
   * Read against the answer that came before, never against a remembered one: a
   * composition that was at zero and is played from zero is not a reset.
   */
  private rearmedUnderneath(
    before: BrowserCompositionPlayback | null,
    next: BrowserCompositionPlayback,
    command: BrowserTransportCommand
  ): boolean {
    if (command === 'stop') return false
    if (next.time > 0.25) return false
    if (!before || before.time <= 0.25) return false
    this.apply({ ...next, time: before.time })
    this.request('seek', before.time)
    return true
  }

  private apply(next: BrowserCompositionPlayback | null): void {
    if (!next) return
    this.playback = next
    this.remembered = { time: next.time, playing: next.playing, at: Date.now() }
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
