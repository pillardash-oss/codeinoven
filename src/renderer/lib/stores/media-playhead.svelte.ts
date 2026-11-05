import { SvelteMap } from 'svelte/reactivity'

/**
 * The frame a media surface was left on, and whether it was running.
 *
 * A recording is shown twice in a conversation: small, in the message column, and
 * big, in the fullscreen viewer. Only one of them is in front of the reader at a
 * time, so the one that was is the authority on where the recording got to, and
 * the one that comes back has to be told. Opening the viewer already carries the
 * inline player's position forward; this store is the other direction, so the
 * player left behind in the conversation is on the same second as the one that
 * was just closed instead of on the second the reader left it at before.
 */
export interface MediaPlayheadCheckpoint {
  /** The second the surface was left on. */
  seconds: number
  /** Whether the recording was running at that moment. */
  playing: boolean
}

class MediaPlayheadState {
  /**
   * The last frame each source was left on, keyed by the source's stable url.
   *
   * The key is the media's own url rather than the url an element happens to be
   * loading: a local file is resolved to a streaming url part way through a
   * mount, and the two players must agree on the recording they are both showing.
   */
  private readonly checkpoints = new SvelteMap<string, MediaPlayheadCheckpoint>()

  /** The frame this source's player should take up, if any surface has left one. */
  checkpoint(source: string): MediaPlayheadCheckpoint | undefined {
    return this.checkpoints.get(source)
  }

  /**
   * Leave a frame for the surface that is taking the recording back.
   *
   * Writing a fresh record is what tells the other player to move: a reader who
   * seeks, pauses and closes the viewer a hundred times over the same recording
   * gets a hundred records, and the same second written twice still arrives as a
   * new one.
   */
  handBack(source: string, seconds: number, playing: boolean): void {
    if (!source || !Number.isFinite(seconds) || seconds < 0) return
    this.checkpoints.set(source, { seconds, playing })
  }
}

export const mediaPlayheadState = new MediaPlayheadState()
