import { SvelteSet } from 'svelte/reactivity'
import type { Thread } from '$shared/types'
import { assistants } from '$lib/stores/assistants.svelte'

/**
 * The knowledge thread the panel is looking at, one read per assistant.
 *
 * The read is asynchronous and a user action can replace the result (hide or
 * reveal the thread), so this cannot be a `$derived` over an IPC promise. The
 * state lives here instead of in the component, so the panel never assigns a
 * stateful variable from inside an `$effect`: the effect only asks for the read,
 * and every write happens in a promise callback or in a method the user's own
 * click calls.
 */
export class AssistantPanelKnowledge {
  /** Loaded thread per assistant, keyed so switching assistants never repaints a stale one. */
  private byAssistant = $state<Record<string, Thread | null>>({})
  /** True while a hide or reveal is writing, so its control cannot double-fire. */
  busy = $state(false)
  /** Assistants whose read is in flight, so a repaint does not ask twice. */
  private inFlight = new SvelteSet<string>()

  /** The thread for one assistant, or null until its read lands. */
  thread(assistantId: string | null): Thread | null {
    if (!assistantId) return null
    return this.byAssistant[assistantId] ?? null
  }

  /** Whether this assistant's thread has been read at least once. */
  loaded(assistantId: string | null): boolean {
    if (!assistantId) return false
    return assistantId in this.byAssistant
  }

  /** Read one assistant's thread once. A second call while it is in flight is a no-op. */
  ensure(assistantId: string | null): void {
    if (!assistantId || this.loaded(assistantId) || this.inFlight.has(assistantId)) return
    this.inFlight.add(assistantId)
    void assistants
      .knowledgeThread(assistantId)
      .then((thread) => {
        this.byAssistant[assistantId] = thread
      })
      .catch(() => {
        // A read that fails leaves the panel with no authoring thread rather than
        // a stale one, which is the same state a missing thread paints.
        this.byAssistant[assistantId] = null
      })
      .finally(() => {
        this.inFlight.delete(assistantId)
      })
  }

  /** Replace the thread after a write the user made (hide or reveal). */
  set(assistantId: string | null, thread: Thread | null): void {
    if (!assistantId) return
    this.byAssistant[assistantId] = thread
  }
}
