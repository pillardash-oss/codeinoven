/**
 * The transport a composition preview is shown with.
 *
 * A composition is a page that draws itself: it exposes `cioRenderFrame(seconds)`
 * and, left alone, drives that function from its own `requestAnimationFrame` loop
 * from second zero and never stops. That is the right behaviour for a page opened
 * anywhere else, and the wrong one for a preview: the only way to watch the video
 * is to watch all of it, again and again, and every agent edit that reloads the
 * preview throws the playhead away.
 *
 * So the app owns time while it is showing a composition. This script is injected
 * into the tab after the document loads and installs a transport that draws the
 * frames, plus the two facts the page cannot supply: where the playhead is, and
 * whether it is moving.
 *
 * Two rules make that safe, and both are in the video playbook:
 *
 * 1. A frame is a function of the second alone, which the render contract already
 *    requires, so the transport can draw any second on demand.
 * 2. A page draw is declined twice over, because once is not enough. The transport
 *    replaces the global with a function that ignores page-initiated draws, and it
 *    parks the page's own animation loop outright. A page that cached the draw
 *    function in a variable, or that calls a local one, would otherwise repaint
 *    over the app's frame for as long as the tab lived, which is the difference
 *    between a pause and a page that keeps playing.
 *
 * The soundtrack is reached the same way, and for the same reason. A bed is
 * normally a detached `new Audio(...)` that no document query can find, so every
 * media element that asks to play is recorded as it asks and a play is refused
 * while the transport is paused. Audio contexts are remembered by wrapping their
 * constructor, and suspended with the picture.
 *
 * Everything here is plain JavaScript because it runs in the page, and the file is
 * a pure function of the manifest so it can be checked directly.
 */

/** The global the transport is reachable at, for the app's own commands. */
export const COMPOSITION_TRANSPORT_GLOBAL = '__cioTransport'

/** Ceiling on one tick, so a backgrounded or stalled tab resumes instead of jumping. */
export const TRANSPORT_MAX_TICK_SECONDS = 1

/** How far page audio may drift from the playhead before it is re-timed. */
export const TRANSPORT_MEDIA_RESYNC_SECONDS = 0.25

export interface CompositionTransportOptions {
  /** Seconds the composition runs, from `composition.json`. */
  duration: number
  /** Frames per second the transport steps a single frame by. */
  fps: number
  /**
   * Whether playback starts as soon as the runtime is installed.
   *
   * A viewing wants it moving. A capture wants the opposite, because the frame is
   * the answer there: installed frozen, the runtime still declines the page's own
   * draws, so the frame the app asks for cannot be overwritten by the page's loop
   * while it settles. Defaults to true, so a viewing needs no option.
   */
  autoplay?: boolean
}

/**
 * What installing the transport reports back.
 *
 * `installed` false means the page defines no render function, which is a
 * composition that cannot be played rather than a transport that failed.
 */
export interface CompositionTransportInstall {
  installed: boolean
  reason?: string
}

/**
 * The script that installs the transport in a composition tab.
 *
 * Returns synchronously with `{ installed: true }` once the transport is
 * reachable at `globalThis.__cioTransport`. A page that ignores the render
 * contract is reported rather than guessed at, the same way a capture reports it.
 */
export function compositionTransportScript(options: CompositionTransportOptions): string {
  const duration = Number.isFinite(options.duration) && options.duration > 0 ? options.duration : 0
  const fps = Number.isFinite(options.fps) && options.fps > 0 ? options.fps : 30
  const autoplay = options.autoplay === false ? 'false' : 'true'
  return `(() => {
  const DURATION = ${JSON.stringify(duration)};
  const FPS = ${JSON.stringify(fps)};
  const AUTOPLAY = ${autoplay};
  const MAX_TICK = ${JSON.stringify(TRANSPORT_MAX_TICK_SECONDS)};
  const RESYNC = ${JSON.stringify(TRANSPORT_MEDIA_RESYNC_SECONDS)};
  const previous = globalThis.${COMPOSITION_TRANSPORT_GLOBAL};
  if (previous && typeof previous.dispose === 'function') previous.dispose();
  const render = globalThis.cioRenderFrame;
  if (typeof render !== 'function') {
    return { installed: false, reason: 'the page defines no cioRenderFrame function' };
  }
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  const caf = globalThis.cancelAnimationFrame.bind(globalThis);
  let pending = 0;
  // Negative until the first tick, rather than zero: a synthetic clock can hand
  // out a timestamp of exactly zero, and that must not read as "no baseline yet".
  let lastAt = -1;
  const transport = {
    duration: DURATION,
    fps: FPS,
    time: 0,
    playing: false,
    loop: true,
    error: null
  };

  /* ── The page's own loop is parked while the app shows the composition ── */

  /**
   * Callbacks the page asked for while its loop is parked.
   *
   * Held rather than scheduled, so the page cannot repaint over the frame the
   * transport drew, however it reaches its draw function. Bounded, because a page
   * that registers a callback on every attempt must not queue without limit.
   */
  let parkedCallbacks = [];
  let parkedCallbackId = -1;
  const MAX_PARKED_CALLBACKS = 64;

  function parkedRaf(callback) {
    if (parkedCallbacks.length >= MAX_PARKED_CALLBACKS) return 0;
    const id = parkedCallbackId;
    parkedCallbackId -= 1;
    parkedCallbacks.push({ id, callback });
    return id;
  }

  function parkedCaf(id) {
    if (typeof id === 'number' && id < 0) {
      const index = parkedCallbacks.findIndex((entry) => entry.id === id);
      if (index >= 0) parkedCallbacks.splice(index, 1);
      return;
    }
    caf(id);
  }

  function parkPageLoop() {
    globalThis.requestAnimationFrame = parkedRaf;
    globalThis.cancelAnimationFrame = parkedCaf;
  }

  /**
   * Give the page its own clock back.
   *
   * The callbacks the page registered while parked are dropped rather than
   * replayed: disposing happens when a fresh runtime is about to replace this one,
   * so replaying them would let the page draw once with a jumped clock in the gap,
   * and a composition is only ever shown inside this app, where the transport is
   * the clock.
   */
  function releasePageLoop() {
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = caf;
    parkedCallbacks = [];
  }

  /* ── The soundtrack, whether or not it is in the document ── */

  /**
   * Every media element that has asked to play.
   *
   * A composition's bed is normally a detached \`new Audio(...)\`, which
   * \`document.querySelectorAll\` cannot see, and a soundtrack that keeps sounding
   * behind a paused picture is the whole defect this closes. Recording the element
   * as it asks is what makes such an element reachable at all.
   */
  const watchedMedia = new Set();
  const MAX_WATCHED_MEDIA = 128;
  let releaseMediaWatch = null;

  function watchMedia() {
    const prototype = globalThis.HTMLMediaElement && globalThis.HTMLMediaElement.prototype;
    if (!prototype || typeof prototype.play !== 'function') return;
    const original = prototype.play;
    const patched = function () {
      watchedMedia.add(this);
      if (watchedMedia.size > MAX_WATCHED_MEDIA) {
        const oldest = watchedMedia.values().next().value;
        if (oldest !== undefined) watchedMedia.delete(oldest);
      }
      // Nothing starts sounding behind a still frame: a page whose boot runs after
      // the composition was armed frozen would otherwise play over a pause.
      if (!transport.playing) {
        try {
          this.pause();
        } catch {
          // A pause that fails changes nothing, because the element was not running.
        }
        return Promise.resolve();
      }
      return original.apply(this, arguments);
    };
    prototype.play = patched;
    releaseMediaWatch = () => {
      if (prototype.play === patched) prototype.play = original;
    };
  }

  /**
   * Audio contexts the page opened, so a synthesized soundtrack stops with the
   * picture.
   *
   * A context is a constructor call rather than a node, so it cannot be found
   * after the fact: the constructor is wrapped while the runtime is armed, and
   * every context it hands out is remembered.
   */
  const watchedContexts = new Set();
  const MAX_WATCHED_CONTEXTS = 32;
  const releaseContextWatches = [];

  function watchAudioContexts() {
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const Original = globalThis[name];
      if (typeof Original !== 'function') continue;
      const Tracked = function () {
        const context = new Original(...arguments);
        watchedContexts.add(context);
        if (watchedContexts.size > MAX_WATCHED_CONTEXTS) {
          const oldest = watchedContexts.values().next().value;
          if (oldest !== undefined) watchedContexts.delete(oldest);
        }
        return context;
      };
      Tracked.prototype = Original.prototype;
      globalThis[name] = Tracked;
      releaseContextWatches.push(() => {
        if (globalThis[name] === Tracked) globalThis[name] = Original;
      });
    }
  }

  /** Every media element the app can reach: what the page started, plus what is in
   *  the document in case the page replaced the element it started. */
  function mediaElements() {
    let listed = [];
    try {
      listed = Array.prototype.slice.call(document.querySelectorAll('audio, video'));
    } catch {
      listed = [];
    }
    for (const element of listed) watchedMedia.add(element);
    return Array.from(watchedMedia);
  }

  function syncAudioContexts(playing) {
    for (const context of watchedContexts) {
      try {
        const settled = playing ? context.resume() : context.suspend();
        if (settled && typeof settled.catch === 'function') settled.catch(() => {});
      } catch {
        // A context that refuses to settle is the page's business.
      }
    }
  }

  function clampTime(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return 0;
    return value > DURATION ? DURATION : value;
  }

  function state() {
    return {
      time: transport.time,
      playing: transport.playing,
      duration: DURATION,
      loop: transport.loop,
      error: transport.error
    };
  }

  /** Draw one frame, and report rather than throw: a frame that fails must not
   *  take the transport down with it, and the message is shown to the user. */
  function renderAt(seconds) {
    try {
      render(seconds);
      transport.error = null;
      return true;
    } catch (error) {
      transport.error = String(error);
      return false;
    }
  }

  /**
   * Re-time the page's own media to the playhead, or stop it with the picture.
   *
   * Everything the page has started is reached rather than only what is in the
   * document, because a bed is normally a detached element. Contexts settle with
   * the picture too, so a synthesized soundtrack stops when the picture does.
   */
  function syncMedia(playing) {
    for (const element of mediaElements()) {
      try {
        if (playing) {
          if (Math.abs(element.currentTime - transport.time) > RESYNC) {
            element.currentTime = transport.time;
          }
          const started = element.play();
          if (started && typeof started.catch === 'function') started.catch(() => {});
        } else {
          element.pause();
        }
      } catch {
        // A soundtrack the page owns is the page's business: one element that
        // refuses to re-time must not stop the picture.
      }
    }
    syncAudioContexts(playing);
  }

  function stopDriver() {
    if (pending !== 0) {
      caf(pending);
      pending = 0;
    }
    lastAt = -1;
  }

  function tick(now) {
    pending = 0;
    if (!transport.playing) return;
    if (lastAt < 0) lastAt = now;
    const elapsed = Math.min(Math.max((now - lastAt) / 1000, 0), MAX_TICK);
    lastAt = now;
    let next = transport.time + elapsed;
    if (next >= DURATION) {
      if (!transport.loop) {
        transport.time = DURATION;
        renderAt(DURATION);
        transport.playing = false;
        syncMedia(false);
        return;
      }
      next = DURATION > 0 ? next % DURATION : 0;
      transport.time = next;
      syncMedia(true);
    } else {
      transport.time = next;
    }
    if (!renderAt(next)) {
      transport.playing = false;
      return;
    }
    pending = raf(tick);
  }

  function play() {
    if (transport.time >= DURATION) transport.time = 0;
    if (transport.playing) return state();
    transport.playing = true;
    lastAt = -1;
    if (pending === 0) pending = raf(tick);
    syncMedia(true);
    return state();
  }

  function pause() {
    transport.playing = false;
    stopDriver();
    syncMedia(false);
    return state();
  }

  function toggle() {
    return transport.playing ? pause() : play();
  }

  function seek(seconds) {
    transport.time = clampTime(seconds);
    renderAt(transport.time);
    syncMedia(transport.playing);
    return state();
  }

  function stop() {
    transport.playing = false;
    stopDriver();
    transport.time = 0;
    renderAt(0);
    syncMedia(false);
    return state();
  }

  function setLoop(on) {
    transport.loop = on === true;
    return state();
  }

  /** Freeze on one frame, for a capture: the frame is the answer, not playback. */
  function freezeAt(seconds) {
    transport.playing = false;
    stopDriver();
    transport.time = clampTime(seconds);
    syncMedia(false);
    renderAt(transport.time);
    return state();
  }

  function dispose() {
    transport.playing = false;
    stopDriver();
    // The picture and the sound both stop with the runtime, so a disposed runtime
    // cannot leave a tab playing under a bar that no longer answers.
    syncMedia(false);
    releasePageLoop();
    if (releaseMediaWatch) releaseMediaWatch();
    for (const release of releaseContextWatches) release();
    // Only take the global back if it is still ours: a page that redefined its
    // render function after this runtime was installed keeps its own definition.
    if (globalThis.cioRenderFrame === declinedDraw) globalThis.cioRenderFrame = render;
    // Nothing may command a disposed transport, so it stops being reachable.
    if (globalThis.${COMPOSITION_TRANSPORT_GLOBAL} === transport) {
      globalThis.${COMPOSITION_TRANSPORT_GLOBAL} = undefined;
    }
  }

  // The page's own loop keeps running, because a composition is also opened
  // outside this app; its draws are simply declined, so two clocks can never
  // fight over which frame is on screen.
  function declinedDraw() {
    return undefined;
  }

  transport.play = play;
  transport.pause = pause;
  transport.toggle = toggle;
  transport.seek = seek;
  transport.stop = stop;
  transport.setLoop = setLoop;
  transport.freezeAt = freezeAt;
  transport.state = state;
  transport.dispose = dispose;
  // The runtime owns the page from here: its loop is parked so it cannot repaint
  // over the transport's frame, its soundtrack is reachable wherever the page put
  // it, and its audio contexts are remembered so they settle with the picture.
  watchMedia();
  watchAudioContexts();
  parkPageLoop();
  globalThis.cioRenderFrame = declinedDraw;
  globalThis.${COMPOSITION_TRANSPORT_GLOBAL} = transport;

  // The first frame is drawn before playback starts, so a composition paused at
  // zero shows its opening rather than whatever the page left behind. A first
  // frame that throws leaves it paused with the reason recorded, because playing a
  // page that cannot draw is a black rectangle with a moving playhead.
  //
  // Installed frozen, the page's own media is stopped as well. Only a transport
  // command ever re-timed media before this, so a project that starts a soundtrack
  // of its own would have sounded while the app believed it was showing a still.
  // Sound returns with the first play, which is the moment the user asked for it.
  if (!AUTOPLAY) syncMedia(false);
  if (renderAt(0) && AUTOPLAY) play();
  return { installed: true };
})()`
}

/**
 * A command the app sends to a composition's transport.
 *
 * `seek` carries seconds and `loop` carries a boolean; the rest take no value.
 * The command decides which function runs, so the app never evaluates a string a
 * caller supplied.
 */
export type CompositionTransportCommand =
  'play' | 'pause' | 'toggle' | 'stop' | 'seek' | 'loop' | 'freeze'

/**
 * The script that runs one transport command and answers with the new state.
 *
 * Reading state through the command's own return value rather than a second call
 * means the panel reflects what actually happened, including a play that ended
 * immediately because the composition has no length.
 */
export function compositionTransportCommandScript(
  command: CompositionTransportCommand,
  value: number | boolean
): string {
  const call =
    command === 'seek'
      ? `seek(${JSON.stringify(typeof value === 'number' && Number.isFinite(value) ? value : 0)})`
      : command === 'loop'
        ? `setLoop(${value === true ? 'true' : 'false'})`
        : command === 'freeze'
          ? `freezeAt(${JSON.stringify(typeof value === 'number' && Number.isFinite(value) ? value : 0)})`
          : `${command}()`
  return `(() => {
  const transport = globalThis.${COMPOSITION_TRANSPORT_GLOBAL};
  if (!transport) return null;
  return transport.${call};
})()`
}

/** The script that reads a composition's playback state without changing it. */
export function compositionTransportStateScript(): string {
  return `(() => {
  const transport = globalThis.${COMPOSITION_TRANSPORT_GLOBAL};
  if (!transport || typeof transport.state !== 'function') return null;
  return transport.state();
})()`
}
