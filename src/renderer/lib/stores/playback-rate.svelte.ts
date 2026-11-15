import { SvelteMap } from 'svelte/reactivity'

/**
 * The speed each recording is being played at.
 *
 * One file is drawn by more than one player: the figure in a conversation and the
 * surface that takes it over full screen are two players for one recording, and
 * the reader set the speed while looking at one of them. The speed therefore lives
 * here, keyed by the same identity the playhead handover uses, so the surface that
 * opens next continues at the speed that was on screen and the two stay in step
 * while both are mounted.
 *
 * One is the default, which is what an unknown key answers: a recording is heard
 * at its own pace until the reader asks for another, and a player never has to
 * remember whether it has a speed of its own.
 */
class PlaybackRateState {
  private readonly rates = new SvelteMap<string, number>()

  /** The speed this recording runs at, one when the reader has not chosen one. */
  rateFor(key: string): number {
    return this.rates.get(key) ?? 1
  }

  /** Set the speed every player of this recording runs at. */
  setRate(key: string, rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0) return
    this.rates.set(key, rate)
  }
}

export const playbackRateState = new PlaybackRateState()
