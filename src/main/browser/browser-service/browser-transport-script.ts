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
 * 2. The page calls `window.cioRenderFrame` through the global. The transport
 *    replaces that global with a function that ignores page-initiated draws, so
 *    the page's own loop cannot fight the transport for the frame. A page that
 *    cached the function in a variable before this ran would keep drawing, which
 *    is why the playbook names the rule.
 *
 * The page is never stopped, muted or hidden: it keeps running, and only its draws
 * are declined. Everything here is plain JavaScript because it runs in the page,
 * and the file is a pure function of the manifest so it can be checked directly.
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

  /** Re-time the page's own media to the playhead, or stop it with the picture. */
  function syncMedia(playing) {
    let media;
    try {
      media = Array.prototype.slice.call(document.querySelectorAll('audio, video'));
    } catch {
      return;
    }
    for (const element of media) {
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
