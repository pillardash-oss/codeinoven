import { originOf } from '../../../lib/local-development-url'
import type { BrowserCompositionPlayback, BrowserTransportCommand } from '../../../lib/ipc-contract'
import { isVideoCaptureUrl } from '../../../lib/video/project'
import { Logger } from '../../system/logger'
import { type BrowserTab } from './browser-types'
import { MAX_TRANSPORT_ERROR_LENGTH } from './browser-validation'
import { liveContents } from './browser-view-contents'
import {
  compositionRenderReadyScript,
  compositionTransportCommandScript,
  compositionTransportScript,
  compositionTransportStateScript
} from './browser-transport-script'
import type { BrowserService } from '../browser-service'

/**
 * The playback transport of a composition tab.
 *
 * A composition page carries its own runtime, so the transport is installed into the
 * document, commanded over an injected global, and answered by the page. This unit owns
 * the arming, the commands, the audio a parked tab gives back, and the shape the panel
 * is published.
 */

/**
 * What `browser-service-transport` reads off the browser service.
 *
 * Each member is the service's own declaration, so this unit and the composition
 * root cannot drift apart: a changed signature is a compile error here.
 */
export interface TransportHost {
  readonly compositionArming: BrowserService['compositionArming']
  readonly mutedCompositions: BrowserService['mutedCompositions']
  readonly playheads: BrowserService['playheads']
  readonly publishState: BrowserService['publishState']
  readonly readPlayhead: BrowserService['readPlayhead']
  readonly requireTab: BrowserService['requireTab']
  readonly tabs: BrowserService['tabs']
  readonly takePlayhead: BrowserService['takePlayhead']
}

/**
 * Read a transport state out of what a composition page answered, or null when it
 * answered nothing usable.
 *
 * The page is a separate document whose shape the app does not control, so every
 * field is checked rather than trusted. A missing or malformed answer is the same
 * as no transport being armed, which is what a tab showing a normal site reports.
 */
export function toCompositionPlayback(value: unknown): BrowserCompositionPlayback | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const time = record['time']
  const duration = record['duration']
  if (typeof time !== 'number' || !Number.isFinite(time)) return null
  if (typeof duration !== 'number' || !Number.isFinite(duration)) return null
  const error = record['error']
  return {
    time: Math.max(0, time),
    duration: Math.max(0, duration),
    playing: record['playing'] === true,
    loop: record['loop'] === true,
    error:
      typeof error === 'string' && error.length > 0
        ? error.slice(0, MAX_TRANSPORT_ERROR_LENGTH)
        : null
  }
}

export class BrowserServiceTransport {
  constructor(private readonly host: TransportHost) {}

  /**
   * Install the playback transport in a composition tab.
   *
   * This is the handover that turns a composition from a page that plays itself
   * into a video: the runtime draws every frame and the panel drives the playhead,
   * so a piece of work can be paused, scrubbed and replayed instead of watched from
   * the start every time it is looked at.
   *
   * Three rules keep the playhead honest, and each of them exists because of a way
   * it was being lost:
   *
   * - A document is armed once, for the timeline it was armed with. Recognition
   *   resolves after the load, so a navigation can be armed from the mark the tab
   *   carried a moment ago and then asked to arm again for the folder it actually
   *   arrived on; without this, the second install restarts the video.
   * - A composition is restored from the playhead saved for *its* folder. A tab
   *   reused for a different composition must not inherit the previous one's
   *   position.
   * - A re-arm of a running document takes its position from the page rather than
   *   from the saved value, which belongs to the document that has already gone.
   *
   * A capture URL is armed frozen rather than played. The runtime still declines the
   * page's own draws, which is what makes the captured frame the frame that was
   * asked for, but it never starts moving and never restores a playhead: the picture
   * is the answer there, not playback.
   */
  async armCompositionTransport(tabId: string, tab: BrowserTab): Promise<void> {
    const generation = tab.navigationGeneration
    const pending = this.host.compositionArming.get(tab)
    if (pending?.generation === generation) return pending.promise
    const promise = this.installCompositionTransport(tabId, tab)
    this.host.compositionArming.set(tab, { generation, promise })
    try {
      await promise
    } finally {
      if (this.host.compositionArming.get(tab)?.promise === promise)
        this.host.compositionArming.delete(tab)
    }
  }

  async installCompositionTransport(tabId: string, tab: BrowserTab): Promise<void> {
    const composition = tab.composition
    const contents = tab.view.webContents
    if (!composition || contents.isDestroyed()) return
    const url = contents.getURL()
    // Recognition resolves after the load, so the mark a tab is holding can name the
    // folder it just left. Every served folder keeps its own loopback origin, so the
    // origin is what tells the document in front of us from the one the mark
    // describes: arming on a stale mark would drive this page with another
    // composition's timeline.
    if (originOf(url) !== composition.origin) return
    const frozen = isVideoCaptureUrl(url)
    const generation = tab.navigationGeneration
    const armed = tab.transport
    if (
      armed !== null &&
      armed.generation === generation &&
      armed.duration === composition.duration &&
      armed.fps === composition.fps
    ) {
      // The same document, already driven by the same timeline.
      return
    }
    // A re-arm of the document that is on screen right now keeps where the user is
    // rather than the position saved for a document that has been replaced.
    const live = armed?.generation === generation ? await this.host.readPlayhead(tabId) : null
    // A page load arms playing unless told otherwise. Nothing here may start a film
    // the user did not ask to play: a composition opens paused, and only a viewing
    // that was already playing resumes. The saved position is only read here, so an
    // arming that gives up early still leaves it for the next attempt.
    const saved = this.host.playheads.get(tabId)
    const resumesPlaying = saved?.directory === composition.directory && saved.playing
    this.applyTransportAudio(tabId, tab, false)
    // Load events do not wait for an async film's images, fonts or runtime bind.
    // Wait in the page, with one bounded startup timer and no main-process poll.
    const ready: unknown = await contents.executeJavaScript(compositionRenderReadyScript())
    if (
      contents.isDestroyed() ||
      tab.navigationGeneration !== generation ||
      tab.composition?.directory !== composition.directory ||
      tab.composition.duration !== composition.duration ||
      tab.composition.fps !== composition.fps
    )
      return
    if (ready !== true) {
      Logger.dev('Composition playback is waiting for cioRenderFrame:', { tabId })
      return
    }
    const result: unknown = await contents.executeJavaScript(
      compositionTransportScript({
        duration: composition.duration,
        fps: composition.fps,
        autoplay: !frozen && resumesPlaying
      })
    )
    const record =
      typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : null
    if (record?.['installed'] !== true) {
      const reason = typeof record?.['reason'] === 'string' ? record['reason'] : 'unknown reason'
      // A folder listing, or a composition whose page has not defined the render
      // function yet, is an ordinary thing to be looking at rather than a fault.
      Logger.dev('Composition playback was not armed:', { tabId, reason })
      // A preview the runtime could not drive is still a preview the app put on
      // screen, and one that cannot be stopped must not be audible.
      this.applyTransportAudio(tabId, tab, false)
      return
    }
    // A burst of agent writes reloads a preview more than once, so the document can
    // be replaced while the runtime is being installed. The position then belongs to
    // a document that has gone, and a record naming this one would make the next
    // load believe it was already armed, so neither is kept.
    if (contents.isDestroyed() || tab.navigationGeneration !== generation) return
    tab.transport = { generation, url, duration: composition.duration, fps: composition.fps }
    // A capture URL is silent by definition and a viewing starts playing, so the
    // tab's audio follows what the runtime actually did rather than what was asked
    // of it: a first frame that threw leaves the transport paused and the tab quiet.
    const playback = await this.transportState(tabId)
    this.applyTransportAudio(tabId, tab, playback?.playing === true)
    if (frozen) return
    const playhead = live ?? this.host.takePlayhead(tabId, composition.directory)
    if (!playhead) return
    await this.sendTransport(tabId, 'seek', playhead.time)
    // A reload arms playing, so a composition the user had paused must be paused
    // again: without this, an agent write while the user was stopped would start
    // the video over their still frame.
    await this.sendTransport(tabId, playhead.playing ? 'play' : 'pause', 0)
  }

  /** Arm the transport without letting a playback problem fail a page load. */
  armCompositionQuietly(tabId: string, tab: BrowserTab): void {
    void this.armCompositionTransport(tabId, tab).catch((error: unknown) => {
      Logger.error('A composition preview could not be armed for playback:', error)
    })
  }

  /**
   * Run one playback action on a composition tab and report the state it left.
   *
   * The page owns the frame, so the answer is read back rather than assumed: a play
   * that ended immediately, or a seek the composition clamped to its own length,
   * shows in the panel exactly as it happened.
   */
  async transport(
    tabId: string,
    command: BrowserTransportCommand,
    value: number | boolean
  ): Promise<BrowserCompositionPlayback | null> {
    const tab = this.host.requireTab(tabId)
    if (!tab.composition) {
      throw new TypeError('Playback is available on a composition preview only')
    }
    // A user action can recover a document that completed startup after the
    // bounded initial wait, without keeping a failed preview polling forever.
    const recovering = !tab.transport
    if (recovering) await this.armCompositionTransport(tabId, tab)
    // An unavailable controller is shown as paused. Its first Play click must
    // still play if startup has just armed the document with autoplay enabled.
    return this.sendTransport(tabId, recovering && command === 'toggle' ? 'play' : command, value)
  }

  /**
   * A composition tab's playhead, or null when the tab is not playing one.
   *
   * Read without changing anything, because this is what the panel polls to move the
   * scrubber. A tab that is gone, or is not a composition, answers null rather than
   * throwing: the panel can outlive the tab it was reading.
   */
  async transportState(tabId: string): Promise<BrowserCompositionPlayback | null> {
    const tab = this.host.tabs.get(tabId)
    if (!tab || !tab.composition) return null
    const contents = liveContents(tab.view)
    if (!contents) return null
    const result: unknown = await contents.executeJavaScript(compositionTransportStateScript())
    return toCompositionPlayback(result)
  }

  async sendTransport(
    tabId: string,
    command: BrowserTransportCommand,
    value: number | boolean
  ): Promise<BrowserCompositionPlayback | null> {
    const tab = this.host.tabs.get(tabId)
    if (!tab) return null
    const contents = liveContents(tab.view)
    if (!contents) return null
    const result: unknown = await contents.executeJavaScript(
      compositionTransportCommandScript(command, value)
    )
    const playback = toCompositionPlayback(result)
    // The runtime declines the page's draws, parks its loop and pauses the media it
    // knows about, but a page can always start sound none of that reaches. The tab
    // is muted for exactly as long as the transport is not playing, which is the
    // one lever no composition can work around. A command that never reached the
    // page reports nothing, and an unreachable composition is quiet by default.
    if (tab.composition) this.applyTransportAudio(tabId, tab, playback?.playing === true)
    return playback
  }

  /**
   * Mute a composition tab for as long as its transport is not playing.
   *
   * The page-side runtime pauses the media it can reach; this is the part it cannot.
   * Muting the view silences a detached element the runtime never saw, a synthesized
   * track, and a frame the page starts behind the player's back. The app only lifts a
   * mute it made itself, so a tab the user muted stays muted through a play.
   */
  applyTransportAudio(tabId: string, tab: BrowserTab, playing: boolean): void {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    // A mute the user chose belongs to the composition, not to the tab, so it
    // outlives every reload, re-open and thread switch until they unmute it.
    if (this.host.mutedCompositions.has(tab.composition?.directory ?? '')) {
      if (!contents.isAudioMuted()) {
        contents.setAudioMuted(true)
        this.host.publishState(tabId)
      }
      tab.transportMuted = false
      return
    }
    if (playing) {
      if (tab.transportMuted && contents.isAudioMuted()) {
        contents.setAudioMuted(false)
        this.host.publishState(tabId)
      }
      tab.transportMuted = false
      return
    }
    if (contents.isAudioMuted()) return
    contents.setAudioMuted(true)
    tab.transportMuted = true
    this.host.publishState(tabId)
  }

  /** Give a tab back the mute the player took from it. */
  releaseTransportAudio(tabId: string, tab: BrowserTab): void {
    if (!tab.transportMuted) return
    tab.transportMuted = false
    // A mute the user chose outlives the player's own mute, so releasing the one
    // must never lift the other.
    if (this.host.mutedCompositions.has(tab.composition?.directory ?? '')) return
    const contents = tab.view.webContents
    if (contents.isDestroyed() || !contents.isAudioMuted()) return
    contents.setAudioMuted(false)
    this.host.publishState(tabId)
  }
}
