import { SvelteSet } from 'svelte/reactivity'

/**
 * The trace steps a reader opened   a single tool call they are inspecting, a
 * reasoning block they are reading, a compaction disclosure   remembered for
 * the visit so no fold upstream can take it away.
 *
 * A trace is a live thing: it appends a step at a time, closes a chain of
 * thought once that chain reports its output, folds itself when the run
 * settles, and re-mounts rows as pages arrive. Every one of those is a reason
 * for a component to be destroyed, and a card's own `$state` dies with it  
 * which is how a tool call the reader had just expanded slammed shut the
 * moment the agent took its next step.
 *
 * The reader's own gesture is not the app's to undo while they are still
 * reading, so expansion lives here instead, keyed by the conversation and the
 * step: the card re-mounts into the state the reader left it in. Leaving the
 * thread forgets the visit (`forgetThread`) exactly like every other
 * interaction state, and nothing here is persisted.
 *
 * Scope is a plain string (`projectId:threadId`) so a surface that renders a
 * trace without a thread   a sub-agent's own transcript   still gets a stable
 * key from the part id alone.
 */
class TraceStepExpansion {
  #expanded = new SvelteSet<string>()

  /** Whether the reader opened this step. Reactive: a re-mounted row reads it. */
  isOpen(scope: string, partId: string): boolean {
    return this.#expanded.has(this.#key(scope, partId))
  }

  /** Record a step's open state. Called from the reader's own toggle. */
  setOpen(scope: string, partId: string, open: boolean): void {
    const key = this.#key(scope, partId)
    if (open) this.#expanded.add(key)
    else this.#expanded.delete(key)
  }

  /** Forget what a visit left open, by scope (a thread being left). */
  forgetScope(scope: string): void {
    const prefix = `${scope}\u0000`
    for (const key of [...this.#expanded]) {
      if (key.startsWith(prefix)) this.#expanded.delete(key)
    }
  }

  #key(scope: string, partId: string): string {
    return `${scope}\u0000${partId}`
  }
}

export const traceStepExpansion = new TraceStepExpansion()

/** The scope a thread's trace steps are remembered under. */
export function traceStepScope(
  projectId: string | undefined,
  threadId: string | undefined
): string {
  return `${projectId ?? ''}:${threadId ?? ''}`
}
