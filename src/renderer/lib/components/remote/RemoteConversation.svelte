<script lang="ts">
  import { onMount } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { SvelteMap } from 'svelte/reactivity'
  import { Loader2, Send, FileText, RefreshCw } from '@lucide/svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { threadSettings, chatEffectiveSettings } from '$lib/stores/thread-settings.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { AgentMessage, AgentPart, Thread, ThreadSettings } from '$shared/types'

  interface Props {
    thread: Thread
    chatMode: boolean
    jumpTarget: { id: string; content: string; nonce: number } | null
  }

  let { thread, chatMode, jumpTarget }: Props = $props()

  let messages = $derived(threadMessages.messages(thread.projectId, thread.id))
  let loaded = $derived(threadMessages.loaded(thread.projectId, thread.id))
  let loading = $derived(threadMessages.loading(thread.projectId, thread.id))
  let loadError = $derived(threadMessages.error(thread.projectId, thread.id))
  let busy = $derived(agentRuns.isBusy(thread.projectId, thread.id))

  let draft = $state('')
  let sendError = $state('')
  let scrollEl = $state<HTMLDivElement>()
  /** Whether the user has scrolled away from the live tail. While away, the
   *  auto-follow must stay released until they scroll back to the bottom. */
  let userScrolledAway = $state(false)
  /** Tracks the last consumed history jump so auto-scroll resumes afterwards. */
  let lastJumpNonce = -1

  const SCROLL_AT_BOTTOM_THRESHOLD = 60

  function isAtBottom(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_AT_BOTTOM_THRESHOLD
  }

  function onScroll(): void {
    if (!scrollEl) return
    userScrolledAway = !isAtBottom(scrollEl)
  }

  const captureScrollElement: Attachment<HTMLDivElement> = (element) => {
    scrollEl = element
    return () => {
      if (scrollEl === element) scrollEl = undefined
    }
  }

  /** Message roots keyed by id — lets history jumps scroll without a DOM query. */
  const messageElements = new SvelteMap<string, HTMLDivElement>()
  const registerMessageElement: Attachment<HTMLDivElement> = (element) => {
    const id = element.dataset.messageId
    if (id) messageElements.set(id, element)
    return () => {
      if (id) messageElements.delete(id)
    }
  }

  /** Effective agent settings for this thread — chats keep their own model. */
  let settings = $derived.by((): ThreadSettings =>
    chatMode ? chatEffectiveSettings() : threadSettings.initialFor(thread)
  )

  onMount(() => {
    const { projectId, id } = thread
    // Keep mobile hydration below the encrypted transport's frame cap. Older
    // history remains available through the existing paged thread API.
    const hydrate = async (): Promise<void> => {
      await threadMessages.load(projectId, id, 40)
      // A thread opened while its turn is still running has its accumulated
      // working trace only in the live harness session — the mirror persists
      // assistant parts only when the turn idles/completes. Pull the live
      // transcript so the in-progress work renders immediately instead of a
      // bare user message that only fills in after the turn ends.
      try {
        const status = await invoke('agent:getSessionStatus', projectId, id)
        if (
          status?.state === 'working' ||
          status?.state === 'waiting' ||
          thread.status === 'planning' ||
          thread.status === 'executing' ||
          thread.status === 'working-paused'
        ) {
          await threadMessages.load(projectId, id)
        }
      } catch {
        // Status is best-effort; the paged mirror already loaded.
      }
    }
    void hydrate()
    const bind = (sessionId: string | undefined): void => {
      if (sessionId) threadMessages.setSessionId(projectId, id, sessionId)
    }
    if (thread.sessionId) {
      bind(thread.sessionId)
    } else {
      void invoke('thread:get', projectId, id)
        .then((data) => {
          bind(data?.sessionId)
        })
        .catch(() => undefined)
    }
  })

  // Auto-scroll to the newest message, and honour history jumps.
  $effect(() => {
    const el = scrollEl
    if (!el) return
    // Track the message list so the effect re-runs when new parts stream in.
    const messageCount = messages.length
    const jump = jumpTarget
    if (jump && jump.nonce !== lastJumpNonce) {
      lastJumpNonce = jump.nonce
      for (const [id, element] of messageElements) {
        if (id === jump.id) {
          el.scrollTop = element.offsetTop - 12
          break
        }
      }
      return
    }
    if (userScrolledAway) return
    el.scrollTop = el.scrollHeight
    void messageCount
  })

  function textFor(message: AgentMessage): string {
    return message.parts
      .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }

  function reasoningFor(message: AgentMessage): string {
    return message.parts
      .filter(
        (part): part is Extract<AgentPart, { type: 'reasoning' }> => part.type === 'reasoning'
      )
      .map((part) => part.summary ?? part.text)
      .join('\n')
  }

  function fileParts(message: AgentMessage): Extract<AgentPart, { type: 'file' }>[] {
    return message.parts.filter(
      (part): part is Extract<AgentPart, { type: 'file' }> => part.type === 'file'
    )
  }

  function toolCount(message: AgentMessage): number {
    return message.parts.filter(
      (part): part is Extract<AgentPart, { type: 'tool' }> => part.type === 'tool'
    ).length
  }

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || busy) return
    draft = ''
    sendError = ''
    try {
      const sessionId = await invoke('agent:ensureSession', thread.projectId, thread.id)
      threadMessages.setSessionId(thread.projectId, thread.id, sessionId)
      await threadMessages.send(thread.projectId, thread.id, settings, text, [], undefined)
    } catch (error) {
      sendError = error instanceof Error ? error.message : 'The message could not be sent.'
    }
  }

  function onComposerKeydown(event: KeyboardEvent): void {
    // Enter is never a send key — only Cmd/Ctrl+Enter sends, so plain Enter and
    // Shift+Enter always insert newlines without risking a premature send.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void send()
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <div
    {@attach captureScrollElement}
    class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4"
    onscroll={onScroll}
  >
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-4">
      {#if !loaded && loading}
        <div class="flex items-center gap-2 px-2 text-sm text-muted">
          <Loader2 size={15} class="animate-spin" />
          Loading conversation…
        </div>
      {:else if messages.length === 0}
        <div class="flex flex-col items-center gap-2 px-2 py-12 text-center">
          <p class="text-sm text-muted">No messages yet</p>
          <p class="max-w-64 text-[13px] leading-relaxed text-dimmed">
            Send a message to get started with this {chatMode ? 'chat' : 'thread'}.
          </p>
        </div>
      {:else}
        {#each messages as message, index (message.id)}
          {@const text = textFor(message)}
          {@const reasoning = reasoningFor(message)}
          {@const files = fileParts(message)}
          {@const tools = toolCount(message)}
          <div
            {@attach registerMessageElement}
            class="group flex flex-col gap-1.5"
            data-message-id={message.id}
          >
            {#if message.role === 'user'}
              <div class="flex justify-end">
                <div class="max-w-[85%] rounded-2xl bg-surface px-3.5 py-2.5">
                  {#if files.length > 0}
                    <div class="mb-1.5 flex flex-wrap justify-end gap-1.5">
                      {#each files as part (part.id)}
                        <span
                          class="flex max-w-full items-center gap-1.5 rounded-lg bg-elevated px-2 py-1 text-[11px] text-muted"
                          title={part.filename ?? part.url}
                        >
                          <FileText size={11} class="shrink-0" />
                          <span class="max-w-40 truncate"
                            >{part.filename ?? part.url.split('/').pop() ?? 'file'}</span
                          >
                        </span>
                      {/each}
                    </div>
                  {/if}
                  {#if text}
                    <p
                      class="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
                    >
                      {text}
                    </p>
                  {/if}
                </div>
              </div>
            {:else}
              <div class="flex flex-col gap-1.5">
                {#if message.error}
                  <p
                    class="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger"
                  >
                    {message.error}
                  </p>
                {/if}
                {#if reasoning}
                  <p
                    class="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-dimmed"
                  >
                    {reasoning}
                  </p>
                {/if}
                {#if text}
                  <p
                    class="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
                  >
                    {text}
                  </p>
                {/if}
                {#if tools > 0}
                  <p class="text-[11px] text-dimmed">
                    {tools} tool {tools === 1 ? 'call' : 'calls'} this turn
                  </p>
                {/if}
                {#if files.length > 0}
                  <div class="flex flex-wrap gap-1.5">
                    {#each files as part (part.id)}
                      <span
                        class="flex max-w-full items-center gap-1.5 rounded-lg bg-elevated px-2 py-1 text-[11px] text-muted"
                        title={part.filename ?? part.url}
                      >
                        <FileText size={11} class="shrink-0" />
                        <span class="max-w-40 truncate"
                          >{part.filename ?? part.url.split('/').pop() ?? 'file'}</span
                        >
                      </span>
                    {/each}
                  </div>
                {/if}
                {#if index === messages.length - 1 && busy}
                  <div class="flex items-center gap-2 text-xs text-dimmed">
                    <Loader2 size={13} class="animate-spin" />
                    Working…
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {/if}

      {#if loadError}
        <div
          class="flex items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger"
        >
          <span>{loadError}</span>
          <button
            type="button"
            class="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs text-danger transition-colors hover:bg-danger/10"
            title="Retry loading the conversation"
            aria-label="Retry loading the conversation"
            onclick={() => void threadMessages.load(thread.projectId, thread.id)}
          >
            <RefreshCw size={13} />
            Retry
          </button>
        </div>
      {/if}

      {#if sendError}
        <p
          class="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger"
        >
          {sendError}
        </p>
      {/if}
    </div>
  </div>

  <div
    class="shrink-0 border-t border-border bg-surface px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-2.5"
  >
    <form
      class="flex items-end gap-2"
      onsubmit={(event: SubmitEvent) => {
        event.preventDefault()
        void send()
      }}
    >
      <textarea
        bind:value={draft}
        rows={1}
        class="min-h-10 flex-1 resize-none rounded-xl border border-border bg-elevated px-3 py-2 text-sm text-foreground outline-none placeholder:text-dimmed focus:border-primary"
        placeholder={busy ? 'Wait for the agent to finish…' : 'Message…'}
        aria-label="Message"
        disabled={busy}
        onkeydown={onComposerKeydown}></textarea>
      <button
        type="submit"
        class="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        disabled={busy || draft.trim().length === 0}
        title="Send message"
        aria-label="Send message"
      >
        <Send size={17} />
      </button>
    </form>
  </div>
</div>
