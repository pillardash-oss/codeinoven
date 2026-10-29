<script lang="ts">
  import type { AgentMessage } from '$shared/types'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'

  /**
   * The first thing the conversation shows.
   *
   * A launch restores a thread the user was already reading, and the transcript
   * that thread needs is read before the app mounts (see
   * `preloadRestoredThreadConversation`). Everything else on the way to the real
   * conversation view is not needed to answer "what was I reading": the thread
   * list, the projects, the composer, the file-changes card, and the conversation
   * renderer's own module graph all arrive later.
   *
   * So this surface paints from that one read as soon as it lands: the last
   * prompt, the folded marker where the work trace sits, and the answer it
   * produced. It is deliberately plain text with the conversation's own
   * typography, because formatting the markdown is the renderer's job and this
   * exists to be replaced by it, not to imitate it.
   *
   * `ThreadView` takes over the moment the workspace has resolved the thread row,
   * which is why nothing here is interactive.
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
</script>

<div
  class="conversation-first-paint flex h-full min-h-0 flex-col justify-end overflow-hidden"
  aria-busy="true"
  data-conversation-first-paint
>
  <div class="conversation-gutter mx-auto w-full max-w-3xl px-6 pb-10">
    {#if prompt}
      <div class="mb-6 whitespace-pre-wrap text-sm leading-relaxed text-muted">{prompt}</div>
    {:else}
      <!-- Nothing in hand yet: a quiet skeleton rather than a black column, so
           the pane never reads as broken while the transcript read lands. -->
      <div class="mb-6 flex flex-col gap-2" aria-hidden="true">
        <span class="h-2 w-2/3 bg-border/60"></span>
        <span class="h-2 w-1/2 bg-border/40"></span>
      </div>
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
    {:else}
      <div class="flex flex-col gap-2" aria-hidden="true">
        <span class="h-2 w-5/6 bg-border/40"></span>
        <span class="h-2 w-3/4 bg-border/30"></span>
      </div>
    {/if}
  </div>
</div>
