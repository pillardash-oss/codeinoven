<script lang="ts">
  import { GitFork, Loader2, Search, Shredder, Trash2, X } from '@lucide/svelte'
  import { tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import type { BrowserViewBounds } from '$shared/ipc-contract'
  import { NativeFloatingPanel } from '$lib/native-floating-panel.svelte'
  import { browserVisibility, trackBrowserOcclusion } from '$lib/stores/browser-visibility.svelte'

  export type DeleteMode = 'down' | 'single' | 'up'

  interface HistoryEntry {
    id: string
    content: string
    /** App-recorded action (an answered question, a retry, a spec apply), not
     *  an authored message. Rendered in italics so the two read differently. */
    isAction?: boolean
    /** First few work-trace snippets of the turn that follows this message. */
    tracePreview?: string[]
  }

  interface Props {
    messages: HistoryEntry[]
    /** A turn is running   destructive actions are disabled. */
    busy?: boolean
    /** Id currently being forked. */
    forkingId?: string | null
    onSelect: (id: string) => void
    onFork: (id: string) => void
    onDelete: (id: string, mode: DeleteMode) => void
    onClose: () => void
  }

  let {
    messages,
    busy = false,
    forkingId = null,
    onSelect,
    onFork,
    onDelete,
    onClose
  }: Props = $props()

  let searching = $state(false)
  let query = $state('')
  let searchInput = $state<HTMLInputElement | undefined>()

  /**
   * The live host that draws this panel above a browser page.
   *
   * A browser page is a native view the compositor paints above every DOM node of
   * this window, and this panel is docked over the column a page occupies (the
   * context sidebar). An occluding overlay resolves that by parking the page
   * (`trackBrowserOcclusion`), which leaves the browser blank for as long as the
   * panel is open   the one outcome a panel over a live page must not have. The
   * panel is instead drawn by the shared native host while a page is on screen,
   * exactly as a dockable panel is (`ui/DockableModal.svelte`), so the page stays
   * attached and keeps running beside and behind the panel.
   *
   * Arming is deliberately narrow: the host is used only while a browser surface
   * actually owns a page (`canUseNativeDock`), which is the one situation where
   * this window cannot draw the panel itself. With no page on screen the panel
   * stays in this window, where it is faithful and free.
   */
  const native = new NativeFloatingPanel(`message-history-${crypto.randomUUID()}`)
  const nativeArmed = $derived(browserVisibility.canUseNativeDock && !native.failed)
  const nativeMount: Attachment<HTMLElement> = (element) => native.mount(element)

  /**
   * The panel's own box in this window, in CSS pixels, which is what the host is
   * placed and sized by.
   *
   * Measured from the frame that carries the panel's geometry rather than from
   * the panel itself, because the host adopts the panel: a rectangle read after
   * adoption belongs to the host window's own coordinate space. The frame never
   * leaves this window, so its rectangle stays the truth through a resize, a
   * theme change, and the handover itself.
   */
  let box = $state<BrowserViewBounds | null>(null)

  const measureBox: Attachment<HTMLElement> = (element) => {
    const measure = (): void => {
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const current = box
      if (
        current &&
        current.x === rect.x &&
        current.y === rect.y &&
        current.width === rect.width &&
        current.height === rect.height
      ) {
        return
      }
      box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }

  // The panel is only ever on screen while this component is mounted, so its
  // visibility is the host's visibility. It stays hidden until its box is known,
  // so the host is never built around a placeholder rectangle.
  $effect(() => {
    native.update(nativeArmed, box !== null, box ?? { x: 0, y: 0, width: 1, height: 1 })
  })

  let normalizedQuery = $derived(query.trim().toLowerCase())
  let visibleMessages = $derived(
    !normalizedQuery
      ? messages.map((message, originalIndex) => ({ message, originalIndex }))
      : messages
          .map((message, originalIndex) => ({ message, originalIndex }))
          .filter(({ message }) => {
            if (message.content.toLowerCase().includes(normalizedQuery)) return true
            return message.tracePreview?.some((snippet) =>
              snippet.toLowerCase().includes(normalizedQuery)
            )
          })
  )

  async function openSearch(): Promise<void> {
    searching = true
    await tick()
    searchInput?.focus()
  }

  function closeSearch(): void {
    searching = false
    query = ''
  }
</script>

<!--
  Full-height history side panel docked left of the context dock rail. User
  messages form a ruled ledger: one hairline per entry, the index in its own
  column so every message starts at the same x, and the turn's work trace
  hanging under its message on a rail aligned with that column. Fork and the
  three delete scopes live here   the conversation screen itself is untouched.
  The row's actions reveal on hover and on keyboard focus, never only on hover.

  The panel's box is the frame; the panel surface inside it is what a native host
  adopts when a browser page is on screen. The frame is then empty and takes no
  pointer, so only the surface the user can actually see answers to a press.
  Until the host has taken over, the frame is held invisible: drawing it here and
  hiding it on the host's confirmation would show the same panel twice, once in
  each skin, and the user would watch it be replaced.

  With no page on screen nothing is armed and the frame draws the panel itself
  and publishes its rectangle, so a page it covers parks exactly as it always
  has: that fallback is what keeps the panel working when no host can draw it.
-->
<div
  class="fixed top-2 bottom-2 right-13 z-40 w-80 {nativeArmed ? 'pointer-events-none' : ''}"
  style:opacity={nativeArmed && !native.live ? 0 : 1}
  {@attach measureBox}
  {@attach nativeArmed ? undefined : trackBrowserOcclusion}
>
  <section
    class="flex h-full w-full flex-col overflow-hidden border border-border bg-surface shadow-lg"
    {@attach nativeMount}
    aria-label="Message history"
  >
    <header class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
      {#if searching}
        <div class="flex min-w-0 flex-1 items-center gap-1.5 px-1">
          <Search size={12} class="shrink-0 text-dimmed" />
          <input
            bind:this={searchInput}
            bind:value={query}
            type="text"
            autocomplete="off"
            spellcheck={false}
            class="min-w-0 flex-1 bg-transparent text-[0.75rem] text-foreground outline-none placeholder:text-dimmed"
            placeholder="Search messages..."
            aria-label="Search messages"
            onkeydown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                if (query) query = ''
                else closeSearch()
              }
            }}
          />
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-label={query ? 'Clear message search' : 'Close message search'}
            title={query ? 'Clear message search' : 'Close message search'}
            onclick={() => {
              if (query) {
                query = ''
                searchInput?.focus()
              } else {
                closeSearch()
              }
            }}
          >
            <X size={12} />
          </button>
        </div>
      {:else}
        <p
          class="min-w-0 flex-1 truncate px-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed"
        >
          Your messages
          {#if messages.length > 0}
            <span class="ml-1 tabular-nums tracking-normal normal-case">({messages.length})</span>
          {/if}
        </p>
      {/if}
      <div class="flex shrink-0 items-center gap-0.5">
        {#if !searching}
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Search messages"
            title="Search messages"
            onclick={() => void openSearch()}
          >
            <Search size={12} />
          </button>
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Close history panel"
            title="Close history panel"
            onclick={onClose}
          >
            <X size={12} />
          </button>
        {/if}
      </div>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto" role="list" aria-label="Your messages">
      {#each visibleMessages as { message, originalIndex } (message.id)}
        <div
          role="listitem"
          class="group/msg border-b border-border transition-colors last:border-b-0 hover:bg-elevated"
        >
          <div class="flex items-center gap-0.5 pr-1">
            <button
              type="button"
              class="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
              title={message.content}
              onclick={() => onSelect(message.id)}
            >
              <span class="w-5 shrink-0 text-right text-[0.625rem] tabular-nums text-dimmed"
                >{originalIndex + 1}</span
              >
              <span
                class="min-w-0 flex-1 truncate text-[0.75rem] text-muted transition-colors group-hover/msg:text-foreground {message.isAction
                  ? 'italic'
                  : ''}"
              >
                {message.content}
              </span>
            </button>
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 hover:bg-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Fork the conversation from this message"
              title="Fork from this message"
              disabled={busy || forkingId !== null}
              onclick={() => onFork(message.id)}
            >
              {#if forkingId === message.id}
                <Loader2 size={12} class="animate-spin" />
              {:else}
                <GitFork size={12} />
              {/if}
            </button>
            {#if originalIndex > 0}
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 hover:bg-raised hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Delete this message and everything before it"
                title="Delete up (this message and everything before)"
                disabled={busy}
                onclick={() => onDelete(message.id, 'up')}
              >
                <Shredder size={12} />
              </button>
            {/if}
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 hover:bg-raised hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="Delete just this message and its work trace"
              title="Delete just this message"
              disabled={busy}
              onclick={() => onDelete(message.id, 'single')}
            >
              <Trash2 size={12} />
            </button>
            {#if originalIndex < messages.length - 1}
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 hover:bg-raised hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                aria-label="Delete this message and everything after it"
                title="Delete down (this message and everything after)"
                disabled={busy}
                onclick={() => onDelete(message.id, 'down')}
              >
                <Shredder size={12} class="rotate-180" />
              </button>
            {/if}
          </div>
          {#if message.tracePreview && message.tracePreview.length > 0}
            <div class="mb-1.5 ml-10 border-l border-border py-0.5 pl-3">
              {#each message.tracePreview as snippet, snippetIndex (snippetIndex)}
                <p class="truncate py-0.5 text-[0.6875rem] text-dimmed" title={snippet}>
                  {snippet}
                </p>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        {#if normalizedQuery}
          <p class="px-3 py-8 text-center text-[0.75rem] text-dimmed">
            No messages match "{query.trim()}"
          </p>
        {:else}
          <p class="px-3 py-8 text-center text-[0.75rem] text-dimmed">No messages yet</p>
        {/if}
      {/each}
    </div>
  </section>
</div>
