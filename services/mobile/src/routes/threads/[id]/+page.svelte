<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { page } from '$app/state'
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import Composer from '#lib/components/Composer.svelte'
  import Sheet from '#lib/components/Sheet.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge, statusSkin, toneColor } from '#lib/api/status'
  import type { Message, Thread } from '#lib/api/types'

  /**
   * One thread, read on a phone. The screen has three parts and no fourth: what
   * the thread is doing, what was said, and the box that writes back. A v1 Oven
   * answers by writing rows the service stores, so a sent prompt is queued
   * locally and the transcript is polled until the answer lands.
   */

  const MESSAGE_LIMIT = 100
  const POLL_INTERVAL = 4000
  const POLL_LIMIT = 120_000

  interface QueuedTurn {
    clientId: string
    body: string
  }

  type Row =
    | { key: string; kind: 'marker'; label: string }
    | { key: string; kind: 'message'; message: Message }
    | { key: string; kind: 'queued'; turn: QueuedTurn }

  let threadId = $derived(page.params.id ?? '')

  let thread = $state<Thread | null>(null)
  let messages = $state<Message[]>([])
  let queued = $state<QueuedTurn[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let drawerOpen = $state(false)
  /** The reading pane is scrolled imperatively, so it needs no reactive state. */
  let chat: HTMLDivElement | null = null

  function attachChat(node: HTMLDivElement): () => void {
    chat = node
    return () => {
      chat = null
    }
  }

  let title = $derived(thread?.title ?? 'Thread')
  let statusLabel = $derived(thread ? statusSkin(thread.status).label : 'Loading')
  let statusTone = $derived(
    thread ? toneColor(statusSkin(thread.status).tone) : 'var(--color-dimmed)'
  )
  let meta = $derived(thread ? `${statusLabel} ${formatAge(thread.lastActivity)}` : statusLabel)
  let rows = $derived(buildRows(messages, queued))
  let details = $derived(
    thread
      ? [
          { label: 'Status', value: statusSkin(thread.status).label },
          { label: 'Project', value: thread.projectId },
          { label: 'Messages', value: String(thread.messageCount) },
          { label: 'Created', value: formatAge(thread.createdAt) },
          { label: 'Updated', value: formatAge(thread.updatedAt) }
        ]
      : []
  )

  /* ---- Reading ---- */

  function dayKey(epoch: number): string {
    const date = new Date(epoch)
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
  }

  /** A phone reads relative days, and names only what "today" cannot say. */
  function dayLabel(epoch: number, now: number): string {
    const key = dayKey(epoch)
    if (key === dayKey(now)) return 'Today'
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (key === dayKey(yesterday.getTime())) return 'Yesterday'
    const date = new Date(epoch)
    const sameYear = date.getFullYear() === new Date(now).getFullYear()
    return date.toLocaleDateString(
      undefined,
      sameYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' }
    )
  }

  function buildRows(items: Message[], pending: QueuedTurn[]): Row[] {
    const out: Row[] = []
    let lastDay = ''
    for (const message of items) {
      const key = dayKey(message.createdAt)
      if (key !== lastDay) {
        out.push({
          key: `day-${key}`,
          kind: 'marker',
          label: dayLabel(message.createdAt, Date.now())
        })
        lastDay = key
      }
      out.push({ key: message.id, kind: 'message', message })
    }
    for (const turn of pending) out.push({ key: turn.clientId, kind: 'queued', turn })
    return out
  }

  /** Blank lines separate paragraphs; a single newline stays inside its own. */
  function paragraphs(body: string): string[] {
    return body
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  }

  async function scrollToEnd(): Promise<void> {
    await tick()
    if (chat) chat.scrollTop = chat.scrollHeight
  }

  function failure(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
  }

  async function load(): Promise<void> {
    if (threadId.length === 0) {
      loading = false
      error = 'This thread is no longer available.'
      return
    }
    loading = true
    error = null
    try {
      const [nextThread, transcript] = await Promise.all([
        api.thread(threadId),
        api.messages(threadId, { limit: MESSAGE_LIMIT })
      ])
      thread = nextThread
      messages = transcript.items
    } catch (cause) {
      error = failure(cause)
    } finally {
      loading = false
    }
    await scrollToEnd()
  }

  /* ---- Waiting for the Oven ---- */

  let timer: ReturnType<typeof setInterval> | null = null
  let pollStartedAt = 0
  let answersAtStart = 0

  function stopPoll(): void {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  function startPoll(): void {
    stopPoll()
    pollStartedAt = Date.now()
    answersAtStart = messages.filter((message) => message.role === 'assistant').length
    timer = setInterval(() => {
      void poll()
    }, POLL_INTERVAL)
  }

  async function poll(): Promise<void> {
    if (Date.now() - pollStartedAt > POLL_LIMIT) {
      stopPoll()
      return
    }
    try {
      const transcript = await api.messages(threadId, { limit: MESSAGE_LIMIT })
      const items = transcript.items
      const answered =
        items.filter((message) => message.role === 'assistant').length > answersAtStart
      messages = items
      if (answered) {
        stopPoll()
        // The stored turns replace the local copies, so nothing is said twice.
        queued = []
        thread = await api.thread(threadId)
      }
      await scrollToEnd()
    } catch {
      // A poll that cannot reach the service is not worth a banner; the next
      // tick tries again, and the two minute limit ends the wait either way.
    }
  }

  function handleQueued(turn: QueuedTurn): void {
    queued = [...queued, turn]
    void scrollToEnd()
    startPoll()
  }

  /* ---- Drawer ---- */

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && drawerOpen) drawerOpen = false
  }

  onMount(() => {
    void load()
  })

  // Teardown is the one thing an effect is right for here: a poll must not
  // outlive the screen that started it.
  $effect(() => {
    return () => stopPoll()
  })
</script>

<svelte:window onkeydown={onKeydown} />

<div class="talk-page">
  <header class="bar talk">
    <div class="bar-row">
      <a class="menu-btn" href="/threads" aria-label="Back to threads" title="Back to threads">
        <CioBack size={20} />
      </a>
      <div class="talk-id">
        <h1>{title}</h1>
        <p class="talk-meta">
          <i class="dot" style:background={statusTone}></i>
          <span>{meta}</span>
        </p>
      </div>
      <button
        class="icon-btn"
        type="button"
        aria-label="Thread details"
        title="Thread details"
        onclick={() => (drawerOpen = true)}
      >
        <CioEllipsis size={20} />
      </button>
    </div>
  </header>

  {#if loading}
    <div class="chat" aria-busy="true" aria-label="Reading the thread">
      <div class="skeleton-block">
        <span class="skeleton" style:width="64%"></span>
        <span class="skeleton" style:width="88%"></span>
        <span class="skeleton" style:width="72%"></span>
        <span class="skeleton" style:width="40%"></span>
      </div>
    </div>
  {:else if error}
    <div class="chat">
      <div class="empty">
        <p>{error}</p>
        <button class="btn" type="button" onclick={load}>Retry</button>
      </div>
    </div>
  {:else}
    <div class="chat" {@attach attachChat}>
      {#each rows as row (row.key)}
        {#if row.kind === 'marker'}
          <p class="marker">{row.label}</p>
        {:else if row.kind === 'queued'}
          <div class="queued">
            <p class="turn-user">{row.turn.body}</p>
            <span class="chip">Queued</span>
          </div>
        {:else if row.message.role === 'user'}
          <p class="turn-user">{row.message.body}</p>
        {:else}
          <article class="turn">
            <div class="answer">
              {#each paragraphs(row.message.body) as paragraph, index (index)}
                <p>{paragraph}</p>
              {/each}
            </div>
          </article>
        {/if}
      {/each}

      {#if rows.length === 0}
        <p class="empty">Nothing has been said in this thread yet.</p>
      {/if}
    </div>
  {/if}

  <div class="slot">
    {#if threadId.length > 0}
      <Composer {threadId} onqueued={handleQueued} />
    {/if}
  </div>

  <Sheet
    open={drawerOpen}
    onclose={() => (drawerOpen = false)}
    placement="right"
    label="Thread details"
  >
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <h2>This thread</h2>
      <button type="button" onclick={() => (drawerOpen = false)}>Done</button>
    </div>
    <div class="drawer-scroll">
      {#each details as detail (detail.label)}
        <div class="run">
          <span>{detail.label}</span>
          <em title={detail.value}>{detail.value}</em>
        </div>
      {/each}
    </div>
  </Sheet>
</div>

<style>
  .talk-page {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    height: 100%;
    min-height: 0;
  }

  /* Assistant prose keeps the author's line breaks without reading raw HTML. */
  .answer p {
    white-space: pre-wrap;
  }

  .queued {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.375rem;
  }

  .queued .turn-user {
    width: 100%;
  }

  .skeleton-block {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .skeleton {
    display: block;
    height: 0.875rem;
    background: var(--color-elevated);
  }

  .empty .btn {
    margin-top: 0.75rem;
  }

  /* The panel comes from the right on a conversation, because the reading column
     stays where it was and the panel is an aside, not a page. */

  .drawer-scroll {
    padding: 0 var(--gutter) 0.5rem;
  }

  .drawer-scroll .run em {
    max-width: 62%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
