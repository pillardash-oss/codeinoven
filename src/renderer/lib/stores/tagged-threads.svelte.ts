import { SvelteMap } from 'svelte/reactivity'
import type { Thread } from '$shared/types'

/**
 * The threads a composer tagged from any project, by id.
 *
 * A tag carries only an id, so a chip in a sent message has to be given a name
 * from somewhere. The Assistant tab's threads come from its own list, but a
 * thread tagged from another project is not in it: the mention search that found
 * it is the only place that saw its title, and it records it here so the chip
 * that is drawn after the send still reads as that thread instead of as a raw
 * `@thread:<id>`.
 *
 * Deliberately a cache, not a store of record: a tag whose thread this session
 * never searched for keeps its literal token, which is the honest reading of an
 * id nothing can name.
 */
class TaggedThreadsStore {
  private readonly threads = $state(new SvelteMap<string, TaggedThread>())

  /** Record threads a tag search found, newest title winning. */
  remember(threads: readonly Pick<Thread, 'id' | 'title' | 'projectId'>[]): void {
    for (const thread of threads) {
      const title = thread.title.trim()
      this.threads.set(thread.id, { id: thread.id, title, projectId: thread.projectId })
    }
  }

  get(threadId: string): TaggedThread | undefined {
    return this.threads.get(threadId)
  }

  get size(): number {
    return this.threads.size
  }
}

/** One recalled thread: enough to name a tag and draw the project it belongs to. */
export interface TaggedThread {
  id: string
  /** The thread's title as stored, without the fallback a display adds. */
  title: string
  projectId: string
}

export const taggedThreads = new TaggedThreadsStore()
