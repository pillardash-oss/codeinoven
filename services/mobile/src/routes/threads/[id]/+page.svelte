<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { page } from '$app/state'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import AnswerTurn from '#lib/components/AnswerTurn.svelte'
  import Composer from '#lib/components/Composer.svelte'
  import PanelBar from '#lib/components/PanelBar.svelte'
  import QueuedStrip from '#lib/components/QueuedStrip.svelte'
  import Sheet from '#lib/components/Sheet.svelte'
  import TurnBubble from '#lib/components/TurnBubble.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge, statusSkin, toneColor } from '#lib/api/status'
  import { arrive } from '#lib/motion'
  import { rememberProject } from '#lib/project-recency'
  import type { Message, Project, Prompt, Thread } from '#lib/api/types'

  /**
   * One thread, read on a phone. The screen has three parts and no fourth: what
   * the thread is doing, what was said, and the box that writes back. A v1 Oven
   * answers by writing rows the service stores, so a sent prompt is held on the
   * composer and its own state polled until the answer lands.
   */

  const MESSAGE_LIMIT = 100
  const POLL_INTERVAL = 4000
  const POLL_LIMIT = 120_000

  type Row =
    | { key: string; kind: 'marker'; label: string }
    | { key: string; kind: 'message'; message: Message }

  let threadId = $derived(page.params.id ?? '')

  let thread = $state<Thread | null>(null)
  /** The thread's project, so the composer can name where a message is written. */
  let project = $state<Project | null>(null)
  let messages = $state<Message[]>([])
  /** The prompts this phone sent that the service has not finished answering. */
  let queued = $state<Prompt[]>([])
  /** What the composer holds. The page owns it, so a held message taken back for
   *  editing lands in the same field its send goes through. */
  let draft = $state('')
  /** Counts drafts handed in from outside, so the field knows to take focus. */
  let draftArrivals = $state(0)
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
  let rows = $derived(buildRows(messages))
  let details = $derived(
    thread
      ? [
          { label: 'Status', value: statusSkin(thread.status).label },
          { label: 'Project', value: project?.name ?? thread.projectId },
          ...(thread.model ? [{ label: 'Model', value: thread.model }] : []),
          ...(thread.harness ? [{ label: 'Harness', value: thread.harness }] : []),
          { label: 'Messages', value: String(thread.messageCount) },
          { label: 'Created', value: formatAge(thread.createdAt) },
          { label: 'Updated', value: formatAge(thread.updatedAt) }
        ]
      : []
  )

  /* ---- Reading ---- */

  /**
   * The transcript groups by calendar day in the reader's own timezone. Intl
   * does that without building a Date per row and without mutating one, which is
   * also what keeps the grouping pure enough to derive.
   */
  const dayKeyFormat = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  })
  const shortDayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
  const longDayFormat = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  const yearFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric' })
  const DAY_MS = 86_400_000

  function dayKey(epoch: number): string {
    return dayKeyFormat.format(epoch)
  }

  /** A phone reads relative days, and names only what "today" cannot say. */
  function dayLabel(epoch: number, now: number): string {
    const key = dayKey(epoch)
    if (key === dayKey(now)) return 'Today'
    if (key === dayKey(now - DAY_MS)) return 'Yesterday'
    return yearFormat.format(epoch) === yearFormat.format(now)
      ? shortDayFormat.format(epoch)
      : longDayFormat.format(epoch)
  }

  function buildRows(items: Message[]): Row[] {
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
    return out
  }

  async function scrollToEnd(): Promise<void> {
    await tick()
    if (chat) chat.scrollTop = chat.scrollHeight
  }

  function failure(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
  }

  /** The project is one quiet read: a failure leaves the composer without it. */
  function loadProject(id: string): void {
    if (id.length === 0) return
    api
      .project(id)
      .then((next) => (project = next))
      .catch(() => (project = null))
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
      // Reading a thread is working on its project: it leads the next chooser.
      void rememberProject(nextThread.projectId)
      loadProject(nextThread.projectId)
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

  function stopPoll(): void {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  function startPoll(): void {
    stopPoll()
    pollStartedAt = Date.now()
    timer = setInterval(() => {
      void poll()
    }, POLL_INTERVAL)
  }

  /**
   * The service owns the queue, so the answer to "is this sent?" is the prompt's
   * own state: once it is done or failed the transcript is re-read and the
   * waiting strip goes away. A prompt that stays claimed simply keeps waiting.
   */
  async function poll(): Promise<void> {
    if (Date.now() - pollStartedAt > POLL_LIMIT) {
      stopPoll()
      return
    }
    if (queued.length === 0) {
      stopPoll()
      return
    }
    try {
      const states = await Promise.all(queued.map((prompt) => api.prompt(prompt.id)))
      const settled = states.filter(
        (prompt) => prompt.state === 'done' || prompt.state === 'failed'
      )
      if (settled.length > 0) {
        const transcript = await api.messages(threadId, { limit: MESSAGE_LIMIT })
        messages = transcript.items
        thread = await api.thread(threadId)
        queued = queued.filter((prompt) => !settled.some((done) => done.id === prompt.id))
        await scrollToEnd()
      } else {
        queued = states
      }
      if (queued.length === 0) stopPoll()
    } catch {
      // A poll that cannot reach the service is not worth a banner; the next
      // tick tries again, and the two minute limit ends the wait either way.
    }
  }

  function handleQueued(turn: { prompt: Prompt; body: string }): void {
    queued = [...queued, turn.prompt]
    void scrollToEnd()
    startPoll()
  }

  function handlePromptRemoved(id: string): void {
    queued = queued.filter((prompt) => prompt.id !== id)
    if (queued.length === 0) stopPoll()
  }

  /** A held message taken back to the box: it leaves the queue and becomes the
   *  draft, so editing and sending go through the one field. */
  function handlePromptEdited(body: string, id: string): void {
    handlePromptRemoved(id)
    draft = body
    draftArrivals += 1
  }

  function handlePromptSteered(prompt: Prompt): void {
    queued = queued.map((held) => (held.id === prompt.id ? prompt : held))
  }

  /* ---- Drawer ---- */

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && drawerOpen) drawerOpen = false
  }

  onMount(() => {
    void load()
    // Teardown belongs to the screen: a poll must not outlive the thread it reads.
    return () => stopPoll()
  })
</script>

<svelte:window onkeydown={onKeydown} />

<div class="talk-page">
  <PanelBar
    {title}
    subtitle={meta}
    tone={statusTone}
    back={{ href: '/threads', label: 'Back to threads' }}
  >
    {#snippet actions()}
      <button
        class="icon-btn"
        type="button"
        aria-label="Thread details"
        title="Thread details"
        onclick={() => (drawerOpen = true)}
      >
        <CioEllipsis size={20} />
      </button>
    {/snippet}
  </PanelBar>

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
          <p class="marker" in:arrive>{row.label}</p>
        {:else if row.message.role === 'user'}
          <div in:arrive>
            <TurnBubble
              body={row.message.body}
              at={row.message.createdAt}
              age={formatAge(row.message.createdAt)}
            />
          </div>
        {:else}
          <div in:arrive>
            <AnswerTurn
              body={row.message.body}
              at={row.message.createdAt}
              age={formatAge(row.message.createdAt)}
              seq={row.message.seq}
              model={thread?.model ?? null}
              harness={thread?.harness ?? null}
            />
          </div>
        {/if}
      {/each}

      {#if rows.length === 0}
        <p class="empty">Nothing has been said in this thread yet.</p>
      {/if}
    </div>
  {/if}

  <div class="slot">
    {#if threadId.length > 0}
      {#if queued.length > 0}
        <QueuedStrip
          prompts={queued}
          onremoved={handlePromptRemoved}
          onedited={handlePromptEdited}
          onsteered={handlePromptSteered}
        />
      {/if}
      <Composer
        {threadId}
        {thread}
        {project}
        working={queued.length > 0}
        bind:draft
        focusSeq={draftArrivals}
        onqueued={handleQueued}
      />
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
