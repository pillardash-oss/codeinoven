<script lang="ts">
  import { Globe } from '@lucide/svelte'
  import ThreadView from '../threads/ThreadView.svelte'
  import { BrowserAssistantChatController } from './BrowserAssistantChatController.svelte'
  import { browserAssistant, type BrowserAssistantChat } from '$lib/stores/browser-assistant.svelte'
  import { faviconState } from '$lib/stores/favicons.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserTabLabel } from '$lib/stores/global-browser-types'

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
   *
   * What it does not share is the conversation surface's *identity*. Before the
   * first message this conversation is about one page, not about starting a
   * generic chat, so the empty state names the page the tab is on and offers the
   * three questions a reader has about a page   the same composer, the same
   * transcript, a different question being asked.
   */
  function resolveChat(): BrowserAssistantChat | null {
    return browserAssistant.chatForThread(threadId)
  }

  // Resolved once per mount; the store stays the owner of the live record, which
  // is what keeps the model and the transcript current while the panel is open.
  const initialChat = resolveChat()
  const controller = initialChat ? new BrowserAssistantChatController(initialChat) : null
  const thread = $derived(browserAssistant.chatForThread(threadId)?.thread ?? initialChat?.thread)

  /**
   * The page this conversation belongs to, read through the tab it is bound to.
   *
   * A conversation belongs to its tab for life, so the tab   never a copy of its
   * title taken when the panel opened   is what answers "which page is this
   * about". Navigating the tab therefore moves the head start with the page, which
   * is exactly what the next turn asks about.
   */
  const pageTabId = initialChat?.browserTabId ?? null
  const pageTab = $derived(pageTabId ? globalBrowser.tabById(pageTabId) : null)
  const pageUrl = $derived(pageTab?.url ?? '')
  const pageLabel = $derived(pageTab ? browserTabLabel(pageTab).trim() : '')
  /** The page's icon: the tab's own, which the tab list keeps written down, else
   *  the shared host cache every other piece of browser chrome resolves through. */
  const pageFavicon = $derived(
    pageTab?.favicon ?? (pageUrl !== '' ? faviconState.faviconFor(pageUrl) : null)
  )

  // The head start is drawn before any page loads, so it needs the icon of an
  // address rather than of a document. The tab carries one itself whenever the app
  // has seen it; this is the same question asked of the shared cache for the
  // address, which is what covers a tab the app has no icon for yet.
  $effect(() => {
    if (pageUrl !== '') faviconState.ensureResolved([pageUrl])
  })

  /** What a reader wants from a page they did not write, in the order they want
   *  it: what it says, then plainly, then what it means. */
  const pagePrompts = [
    'Summarize this page',
    'Explain this page in simple terms',
    'List the key insights on this page'
  ]
</script>

{#snippet pageEmptyStateHeading()}
  <h1
    class="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[1.375rem] font-semibold tracking-tight text-foreground"
  >
    <span>What can I help you with on</span>
    {#if pageLabel !== ''}
      <span class="inline-flex max-w-full min-w-0 items-center gap-1.5">
        {#if pageFavicon}
          <img
            src={pageFavicon}
            alt=""
            aria-hidden="true"
            draggable="false"
            class="size-5 shrink-0 rounded-sm object-contain"
          />
        {:else}
          <Globe size={18} class="shrink-0 text-dimmed" aria-hidden="true" />
        {/if}
        <span class="min-w-0 truncate">{pageLabel}</span>
        <span class="text-dimmed" aria-hidden="true">?</span>
      </span>
    {:else}
      <span>this page?</span>
    {/if}
  </h1>
  <p class="mt-1 text-[0.875rem] text-muted">The agent reads this page as it answers.</p>
{/snippet}

<div class="browser-assistant-chat bg-app flex h-full min-h-0 w-full flex-col overflow-hidden">
  {#if thread && controller}
    <ThreadView
      {thread}
      chatMode
      {controller}
      emptyStateHeading={pageEmptyStateHeading}
      promptSuggestions={pagePrompts}
      composerPlaceholder="Ask about this page..."
    />
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
