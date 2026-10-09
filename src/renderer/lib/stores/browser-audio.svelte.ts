import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { contentThreadFamily, type ContentThreadFamily } from '$lib/content-view-threads'

/**
 * One browser tab's contribution to the app's audio picture.
 *
 * A tab is either a thread-browser tab, which belongs to the conversation that
 * opened it and therefore to that conversation's view family, or a tab of the
 * global browser profile, which belongs to no thread at all.
 */
interface BrowserAudioTab {
  /** The conversation thread that owns the tab, or null for the global profile. */
  threadId: string | null
  /** The view family the tab's thread belongs to, or null for the global profile. */
  family: ContentThreadFamily | null
  /** True while the page is emitting sound and the tab is not muted. */
  audible: boolean
  /** When the tab started playing, for the row indicator's last-action rule. */
  startedAt: number
}

/**
 * Which browser surfaces are playing sound right now.
 *
 * Sound is the one browser state that outlives the surface it comes from: a tab
 * keeps playing while the user is on another thread, another family, or another
 * view entirely, and the page that owns it is exactly the one they can no longer
 * see. The two browser stores therefore publish their live audio here   the
 * thread browser (`context-sidebar-browser`) and the global profile
 * (`global-browser`)   and every surface that has to say "something is playing"
 * reads it from one place:
 *
 *   - the view rail marks the family (or the Browser item) whose browser is
 *     playing, so the user learns where the sound is from without hunting;
 *   - a thread row marks the conversation whose browser tab is playing, so the
 *     sound is attributable once the family is on screen.
 *
 * It lives in its own eager module because the rail is part of the first paint
 * while the global browser is deliberately not: the browser store pushes into
 * this registry, and the rail reads it without ever importing the browser.
 *
 * A muted tab is not audible. Muting is the user's own silence, so the mark must
 * clear the moment they mute, exactly as it clears when the page stops.
 */
class BrowserAudioState {
  /** Live audio state of every browser tab, keyed by tab id. */
  private readonly tabs = new SvelteMap<string, BrowserAudioTab>()

  /** Families whose thread browser has an audible tab. */
  private readonly audibleFamilies = $derived.by((): ReadonlySet<ContentThreadFamily> => {
    const families = new SvelteSet<ContentThreadFamily>()
    for (const tab of this.tabs.values()) {
      if (tab.audible && tab.family) families.add(tab.family)
    }
    return families
  })

  /** Whether the global browser profile has an audible tab. */
  private readonly globalPlaying = $derived.by((): boolean => {
    for (const tab of this.tabs.values()) {
      if (tab.audible && tab.threadId === null) return true
    }
    return false
  })

  /** Report a thread-browser tab's live audio state. */
  reportThreadTab(tabId: string, threadId: string, projectId: string, audible: boolean): void {
    this.write(tabId, audible, threadId, contentThreadFamily({ projectId }))
  }

  /** Report the global browser profile's live audio state. */
  reportGlobalTab(tabId: string, audible: boolean): void {
    this.write(tabId, audible, null, null)
  }

  /** Forget a tab that no longer exists, so its sound mark cannot linger. */
  forget(tabId: string): void {
    this.tabs.delete(tabId)
  }

  /** When a thread's browser audio began, or null while the thread is silent.
   *  The newest of the thread's audible tabs wins, so the row indicator's
   *  last-action rule sees the most recent sound. */
  threadAudioStartedAt(threadId: string): number | null {
    let startedAt: number | null = null
    for (const tab of this.tabs.values()) {
      if (!tab.audible || tab.threadId !== threadId) continue
      startedAt = startedAt === null ? tab.startedAt : Math.max(startedAt, tab.startedAt)
    }
    return startedAt
  }

  /** The families whose thread browser has an audible tab, for a caller that
   *  marks every family at once (the view rail). */
  familiesPlaying(): ReadonlySet<ContentThreadFamily> {
    return this.audibleFamilies
  }

  /** Whether the global browser profile is playing sound. */
  globalIsPlaying(): boolean {
    return this.globalPlaying
  }

  /** Record one tab's audio state, stamping when sound started so a row's
   *  indicator keeps a fair place in its last-action contest. */
  private write(
    tabId: string,
    audible: boolean,
    threadId: string | null,
    family: ContentThreadFamily | null
  ): void {
    const current = this.tabs.get(tabId)
    if (!current) {
      if (!audible) return
      this.tabs.set(tabId, { threadId, family, audible, startedAt: Date.now() })
      return
    }
    if (current.audible === audible && current.threadId === threadId) return
    this.tabs.set(tabId, {
      threadId,
      family,
      audible,
      startedAt: audible && !current.audible ? Date.now() : current.startedAt
    })
  }
}

export const browserAudio = new BrowserAudioState()
