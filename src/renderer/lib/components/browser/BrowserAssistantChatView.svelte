<script lang="ts">
  import ThreadView from '../threads/ThreadView.svelte'
  import { BrowserAssistantChatController } from './BrowserAssistantChatController.svelte'
  import { browserAssistant, type BrowserAssistantChat } from '$lib/stores/browser-assistant.svelte'

  interface Props {
    /** The conversation thread this panel shows. */
    threadId: string
  }

  let { threadId }: Props = $props()

  /**
   * A browser tab's assistant conversation, rendered in the browser's right rail.
   *
   * The conversation is a real chat thread, so the panel is the app's own
   * conversation surface with a controller that keeps it a panel: it never
   * publishes the header state the primary conversation owns. The rail remounts
   * this component per conversation (keyed by thread id), so the controller binds
   * once and the view always shows the thread the tab is on.
   */
  function resolveChat(): BrowserAssistantChat | null {
    return browserAssistant.chatForThread(threadId)
  }

  // Resolved once per mount; the store stays the owner of the live record, which
  // is what keeps the model and the transcript current while the panel is open.
  const initialChat = resolveChat()
  const controller = initialChat ? new BrowserAssistantChatController(initialChat) : null
  const thread = $derived(browserAssistant.chatForThread(threadId)?.thread ?? initialChat?.thread)
</script>

<div class="browser-assistant-chat bg-app flex h-full min-h-0 w-full flex-col overflow-hidden">
  {#if thread && controller}
    <ThreadView {thread} chatMode={true} {controller} />
  {:else}
    <div class="flex flex-1 items-center justify-center px-6 text-sm text-dimmed">
      This conversation is no longer available.
    </div>
  {/if}
</div>

<style>
  /* The composer stays reachable while the transcript scrolls under it, exactly
     as it does in every other chat-shaped surface. */
  .browser-assistant-chat :global(.chat-composer) {
    position: sticky;
    bottom: 0;
    z-index: 10;
  }
</style>
