/** Looping is an explicit choice for one video, never a default for the next. */
class CompositionPlaybackPrefs {
  private loops = $state<Record<string, boolean>>({})

  loopFor(tabId: string): boolean {
    return this.loops[tabId] ?? false
  }

  setLoop(tabId: string, on: boolean): void {
    if (this.loopFor(tabId) === on) return
    // Keep closed preview sessions from growing this preference store indefinitely.
    this.loops = { ...Object.fromEntries(Object.entries(this.loops).slice(-127)), [tabId]: on }
  }
}

export const compositionPlaybackPrefs = new CompositionPlaybackPrefs()
