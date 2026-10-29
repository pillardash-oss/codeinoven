<script lang="ts">
  import type { AgentMessage } from '$shared/types'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'

  /**
   * What the conversation shows before it can show itself.
   *
   * A launch restores a thread the user was already reading, and the transcript
   * that thread needs is read before the app mounts (see
   * `preloadRestoredThreadConversation`). Two things can therefore be true while
   * the real view is still on its way: the transcript is in hand, or it is not.
   *
   * - In hand: paint it. The last prompt, the folded marker where the work trace
   *   sits, and the answer it produced, in the conversation's own typography. This
   *   is plain text because formatting the markdown is the renderer's job and this
   *   surface exists to be replaced by it.
   * - Not yet: a skeleton of the same shape, not an empty column. An empty
   *   conversation pane beside a finished thread list reads as a broken app; a
   *   skeleton reads as one that is loading, which is what is happening.
   *
   * Either way the shape matches the real view (prompt, trace line, answer,
   * composer), so nothing jumps when the renderer takes over.
   */
  interface Props {
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  /** Rendered text of a message, in part order. Only prose parts carry any. */
  function messageText(message: AgentMessage): string {
    const chunks: string[] = []
    for (const part of message.parts) {
      if (part.type === 'text' && part.text.trim().length > 0) chunks.push(part.text.trim())
    }
    return chunks.join('\n\n')
  }

  /** The newest message of a role that has prose worth showing. */
  function newestWithText(
    messages: readonly AgentMessage[],
    role: AgentMessage['role']
  ): string | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (!message || message.role !== role) continue
      const text = messageText(message)
      if (text.length > 0) return text
    }
    return null
  }

  let loaded = $derived(threadMessages.loaded(projectId, threadId))
  let messages = $derived(loaded ? threadMessages.messages(projectId, threadId) : [])
  let prompt = $derived(newestWithText(messages, 'user'))
  let answer = $derived(newestWithText(messages, 'assistant'))
  /** While the first load is still publishing batches, the view is not settled. */
  let settling = $derived(loaded ? threadMessages.revealing(projectId, threadId) : true)
  let showSkeleton = $derived(settling || (prompt === null && answer === null))
</script>

<div
  class="conversation-first-paint flex h-full min-h-0 flex-col justify-end overflow-hidden"
  aria-busy="true"
  data-conversation-first-paint
>
  <div class="conversation-gutter mx-auto w-full max-w-3xl px-6 pb-8">
    {#if showSkeleton}
      <!-- The same silhouette the real conversation has, pulsing as one layer so
           the whole block costs a single composited animation. -->
      <div class="animate-pulse" aria-hidden="true">
        <div class="mb-3 flex items-center gap-2">
          <div class="h-2.5 w-16 bg-overlay"></div>
          <div class="h-2.5 w-10 bg-overlay/60"></div>
        </div>
        <div class="mb-6 flex flex-col gap-2">
          <div class="h-2.5 w-[62%] bg-overlay"></div>
          <div class="h-2.5 w-[38%] bg-overlay/70"></div>
        </div>
        <div class="mb-5 flex items-center gap-2">
          <div class="h-4 w-px bg-border"></div>
          <div class="h-2.5 w-24 bg-overlay"></div>
          <div class="h-2.5 w-10 bg-overlay/50"></div>
        </div>
        <div class="mb-2 flex flex-col gap-2.5">
          <div class="h-2.5 w-[88%] bg-overlay/80"></div>
          <div class="h-2.5 w-[94%] bg-overlay/70"></div>
          <div class="h-2.5 w-[71%] bg-overlay/60"></div>
          <div class="h-2.5 w-[83%] bg-overlay/50"></div>
          <div class="h-2.5 w-[46%] bg-overlay/40"></div>
        </div>
        <!-- The composer's footprint, so the view does not jump when it arrives. -->
        <div class="mt-8 border border-border/60 px-4 py-3">
          <div class="h-2.5 w-[30%] bg-overlay/50"></div>
          <div class="mt-4 flex items-center gap-2">
            <div class="h-3 w-3 bg-overlay/60"></div>
            <div class="h-3 w-3 bg-overlay/40"></div>
            <div class="ml-auto h-3 w-10 bg-overlay/40"></div>
          </div>
        </div>
      </div>
    {:else}
      {#if prompt}
        <div class="mb-6 whitespace-pre-wrap text-sm leading-relaxed text-muted">{prompt}</div>
      {/if}
      <!-- Where the folded work trace sits in the real view. It stays a plain bar
           rather than a copy of the trace header: this surface has no step count,
           duration or compaction flag, and inventing them would read as data. -->
      <div class="mb-5 flex items-center gap-2" aria-hidden="true">
        <span class="h-4 w-px shrink-0 bg-border"></span>
        <span class="h-2 w-24 bg-border/70"></span>
        <span class="h-2 w-10 bg-border/40"></span>
      </div>
      {#if answer}
        <div class="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{answer}</div>
      {/if}
    {/if}
  </div>
</div>
