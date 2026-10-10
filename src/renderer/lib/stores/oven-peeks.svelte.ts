import { invoke } from '$lib/ipc.svelte'
import type { OvenPeek } from '$shared/ovens'

/**
 * The renderer's cache of every remote Oven's unified check.
 *
 * One read answers the device, its harnesses, and its packages, so the Ovens
 * list, the setup dialog, and the Oven picker all draw the same answer instead
 * of each running their own read. The work lives here at module scope, not in a
 * component: a check that starts while the Ovens page is open still lands after
 * the user leaves it, and the next visit reads the cache and refreshes again.
 */
class OvenPeekStore {
  #peeks = $state.raw<Record<string, OvenPeek>>({})
  #active = $state.raw<Record<string, boolean>>({})
  #running = new Map<string, Promise<OvenPeek | null>>()

  /** One Oven's already-read check, or null before the first read. */
  peek(ovenId: string): OvenPeek | null {
    return this.#peeks[ovenId] ?? null
  }

  /** True while this Oven's check is in flight, wherever it was started from. */
  running(ovenId: string): boolean {
    return this.#active[ovenId] === true
  }

  /**
   * Read one Oven, hydrating from the cache first and refreshing after.
   *
   * Returns the first available answer: the cached copy when there is one,
   * otherwise the result of the first read. A stale answer is followed by the
   * refresh, which joins whatever read is already in flight in main.
   */
  ensure(ovenId: string): Promise<OvenPeek | null> {
    return this.#start(ovenId, false)
  }

  /** Force a fresh read, e.g. an explicit Check Oven or after a mutation. */
  refresh(ovenId: string): Promise<OvenPeek | null> {
    return this.#start(ovenId, true)
  }

  /** Drop one Oven's answer, e.g. after it was removed. */
  forget(ovenId: string): void {
    if (!(ovenId in this.#peeks)) return
    const next = { ...this.#peeks }
    delete next[ovenId]
    this.#peeks = next
    this.#setActive(ovenId, false)
  }

  #start(ovenId: string, force: boolean): Promise<OvenPeek | null> {
    const running = this.#running.get(ovenId)
    if (running) return running
    const task = this.#run(ovenId, force).finally(() => {
      this.#running.delete(ovenId)
      this.#setActive(ovenId, false)
    })
    this.#running.set(ovenId, task)
    this.#setActive(ovenId, true)
    return task
  }

  async #run(ovenId: string, force: boolean): Promise<OvenPeek | null> {
    try {
      const first = await invoke('oven:peek', ovenId, force)
      this.#set(first)
      if (first.stale) this.#set(await invoke('oven:peek', ovenId, true))
      return this.peek(ovenId)
    } catch {
      // Keep whatever is cached; the next ensure retries the read.
      return this.peek(ovenId)
    }
  }

  #set(peek: OvenPeek): void {
    this.#peeks = { ...this.#peeks, [peek.ovenId]: peek }
  }

  #setActive(ovenId: string, active: boolean): void {
    if (active) this.#active = { ...this.#active, [ovenId]: true }
    else if (ovenId in this.#active) {
      const next = { ...this.#active }
      delete next[ovenId]
      this.#active = next
    }
  }
}

export const ovenPeeks = new OvenPeekStore()
