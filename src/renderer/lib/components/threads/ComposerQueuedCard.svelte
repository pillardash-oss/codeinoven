<script lang="ts">
  import CioArrowUpRight from '@pdslng/cio-icon/CioArrowUpRight.svelte'
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioGrip from '@pdslng/cio-icon/CioGrip.svelte'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import CioPaperclip from '@pdslng/cio-icon/CioPaperclip.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioSend from '@pdslng/cio-icon/CioSend.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import AttachmentPill from '../chats/AttachmentPill.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardStack from '../shared/CardStack.svelte'
  import CardTag from '../shared/CardTag.svelte'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import type { StartAfterThreadReference } from '$lib/stores/renderer-recovery'
  import {
    CPU_AVAILABLE_FLOOR_PERCENT,
    type AdmissionDecision,
    type ResourceWaitTarget
  } from '$shared/resource-admission'
  import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'
  import type { PromptAttachment, UserMessagePresentation } from '$shared/types'
  import {
    QueuedDragReorder,
    type QueuedDragRow
  } from './ComposerQueuedCard/queued-drag-reorder.svelte'
  import type { QueuedRowSummary } from './ComposerQueuedCard/queued-row'

  interface Props {
    /** The message waiting behind the running turn. */
    text: string
    /** True when the queued payload carries attachments or context but no text. */
    hasContent: boolean
    /** Files the queued message carries, shown the way the composer shows them. */
    attachments: PromptAttachment[]
    /** Object URLs for image chips, keyed by the attachment's `file://` URL. */
    previewUrls: Record<string, string>
    /** Every message waiting in the thread's FIFO queue, head (next to send)
     *  first. The head's own detail is drawn from the props above. */
    queue: QueuedRowSummary[]
    /** Selections the queued message answers. */
    promptReferences: ResponseReferenceAnchor[]
    /** A presentation the queued message carries instead of plain text. */
    presentation: UserMessagePresentation | undefined
    /** Threads the queued message waits for before it sends. */
    startAfterThreads: StartAfterThreadReference[]
    /** The reading holding this message, when a machine is what waits. */
    resourceWait?: AdmissionDecision | null
    /** Whose machine the wait belongs to, when a machine is what waits. */
    resourceWaitTarget?: ResourceWaitTarget | null
    /** True while this message is being handed to the conversation. */
    delivering?: boolean
    /** The steer combo, so the send-now action names the key that does it. */
    steerModifierLabel: string
    /** Thread the queued message belongs to, so its fold state is remembered. */
    threadId: string
    /** Another card sits directly above this one, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** Opens one of the queued message's files fullscreen. */
    onPreviewAttachment?: (attachment: PromptAttachment) => void
    onSteer: () => void
    /** Send one queued row now, without waiting for its turn in the queue. */
    onSendQueued: (id: string) => void
    onEdit: () => void
    /** Open one queued row in the composer for editing. */
    onEditQueued: (id: string) => void
    onDelete: () => void
    /** Delete one queued row, leaving the rest of the queue. */
    onDeleteQueued: (id: string) => void
    onDeleteAll: () => void
    /** Move a queued message to a new slot in the queue. */
    onReorder: (id: string, targetIndex: number) => void
    onAddStartAfter: () => void
    onRemoveStartAfter: (dependency: StartAfterThreadReference) => void
    onOpenStartAfter: (threadId: string) => void
    onPreloadStartAfter: (threadId: string) => void
  }

  let {
    text,
    hasContent,
    attachments,
    previewUrls,
    queue,
    promptReferences,
    presentation,
    startAfterThreads,
    resourceWait = null,
    resourceWaitTarget = null,
    delivering = false,
    steerModifierLabel,
    threadId,
    stackedAbove = false,
    onPreviewAttachment,
    onSteer,
    onSendQueued,
    onEdit,
    onEditQueued,
    onDelete,
    onDeleteQueued,
    onDeleteAll,
    onReorder,
    onAddStartAfter,
    onRemoveStartAfter,
    onOpenStartAfter,
    onPreloadStartAfter
  }: Props = $props()

  let queueMenuOpen = $state(false)
  /** The one row whose own actions menu is open, if any. */
  let rowMenuOpenId = $state<string | null>(null)
  let hasQueuedPayload = $derived(text.trim().length > 0 || hasContent)
  /** How many messages wait behind the running turn, head included. */
  const count = $derived(queue.length)
  /** The fold control writes a per-thread preference, so a queued card the
   *  reader folded down stays folded when the thread is reopened. */
  const foldState = {
    get folded(): boolean {
      return threadCardFold.isFolded(threadId, 'queued')
    },
    set folded(value: boolean) {
      threadCardFold.setFolded(threadId, 'queued', value)
    }
  }

  /** The head names what is waiting: a count, a dependency, or one message. */
  const title = $derived(
    resourceWait
      ? 'Low resource available'
      : count > 1
        ? `Queued · ${count}`
        : startAfterThreads.length > 0
          ? 'Starts after'
          : 'Queued message'
  )
  /** The reading is a state, never an invented duration: the app keeps no
   *  timestamp for a queued message, so the chip says what is actually true. */
  const chip = $derived(
    resourceWait
      ? { text: 'Low resource', tone: 'paused' as const }
      : count > 1
        ? { text: `${count} waiting`, tone: 'paused' as const }
        : startAfterThreads.length > 0
          ? { text: 'Waiting', tone: 'paused' as const }
          : undefined
  )

  /** Available CPU, rounded the way a person reads a percentage. */
  function formatPercent(value: number): string {
    return `${Math.max(0, Math.round(value))}%`
  }

  /** Available memory, in the unit that keeps the number short. */
  function formatMemory(bytes: number): string {
    const gigabytes = bytes / 1024 ** 3
    if (gigabytes >= 1) return `${gigabytes.toFixed(1)} GB`
    return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`
  }

  function toggleQueueMenu(): void {
    rowMenuOpenId = null
    queueMenuOpen = !queueMenuOpen
  }

  function toggleRowMenu(id: string): void {
    queueMenuOpen = false
    rowMenuOpenId = rowMenuOpenId === id ? null : id
  }

  function runMenuAction(action: () => void): void {
    queueMenuOpen = false
    action()
  }

  /* ---- Reordering -------------------------------------------------------
     The queue is a FIFO the dispatcher reads from its head, so the order is
     the only thing a reader can change about it. Rows keep their place in the
     DOM while one is held and are displaced with transforms; the store's order
     is rewritten once, on release. */

  const drag = new QueuedDragReorder()
  let listElement = $state<HTMLElement | null>(null)

  /** The queue's rows in queue order, as the drag measures them. */
  function measuredRows(): QueuedDragRow[] {
    const list = listElement
    if (!list) return []
    return Array.from(list.children).flatMap((child) => {
      if (!(child instanceof HTMLElement)) return []
      const id = child.dataset.queuedId
      return id ? [{ id, element: child }] : []
    })
  }

  function startDrag(event: PointerEvent, id: string): void {
    // A pointer gesture is not a click, so the gripper is given the focus the
    // press would normally have moved. Without it, releasing the row leaves a
    // keyboard reader with nothing focused to move it with.
    const handle = event.currentTarget
    if (handle instanceof HTMLElement) handle.focus()
    drag.start(event, measuredRows(), id, (drop) => onReorder(drop.id, drop.targetIndex))
  }

  /** The arrow keys move a row one place, so the queue is reorderable without
   *  a pointer and a keyboard reader is not left with a gripper that does
   *  nothing. */
  function moveWithKeyboard(event: KeyboardEvent, id: string, index: number): void {
    const delta = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (delta === 0) return
    event.preventDefault()
    onReorder(id, index + delta)
  }

  /* Non-reactive on purpose: it only notices that the queue changed under a
     drag that was measuring the older one, e.g. a message was delivered or
     deleted mid-gesture. */
  let measuredQueueIds = ''
  $effect(() => {
    const ids = queue.map((row) => row.id).join('|')
    if (ids === measuredQueueIds) return
    measuredQueueIds = ids
    if (drag.dragging) drag.cancel()
  })

  // A drag in flight holds window listeners; a card that unmounts mid-gesture
  // (a thread switch) must let them go with it.
  $effect(() => () => drag.cancel())
</script>

<!-- A message waiting behind the running turn. It stacks on the composer's top
edge, so it drops its own bottom rule and the composer's dashed top rule carries
the join. One message keeps Send now (the steer key) in the head, with edit and
delete in its menu. Several messages move Send now onto every row, each with its
own menu, and the head's menu only empties the queue: a row sends itself, never
the whole queue. -->
<CardStack
  label="Queued message"
  icon={CioClock}
  {title}
  {chip}
  {stackedAbove}
  foldLabel="queued message"
  bind:folded={foldState.folded}
>
  {#snippet meta()}
    {#if delivering}
      <CardTag text="Sending" />
    {:else if resourceWait}
      <CardTag
        text={resourceWaitTarget?.kind === 'oven'
          ? `Waiting on ${resourceWaitTarget.name}`
          : 'Waiting on this device'}
      />
    {:else if startAfterThreads.length === 0}
      <CardTag text="Sends after this turn" />
    {/if}
  {/snippet}

  {#snippet controls()}
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Add thread to Starts after"
      aria-label="Add thread to Starts after"
      onclick={onAddStartAfter}
    >
      <CioPlus size={13} />
    </button>
    <div class="relative">
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Queued message actions"
        aria-label="Queued message actions"
        aria-haspopup="menu"
        aria-expanded={queueMenuOpen}
        onclick={toggleQueueMenu}
        oncontextmenu={(event: MouseEvent) => {
          event.preventDefault()
          queueMenuOpen = true
        }}
      >
        <CioEllipsis size={13} />
      </button>
      {#if queueMenuOpen}
        <!-- The scrim and the menu ride one rung above the composer (z-40): the
             card sits directly over the composer, so its click-away has to keep
             catching the first click even on the composer surface. -->
        <button
          type="button"
          class="fixed inset-0 z-50 cursor-default"
          aria-label="Close menu"
          onclick={() => (queueMenuOpen = false)}
        ></button>
        <div
          class="absolute bottom-8 right-0 z-50 w-36 border border-border-strong bg-surface p-1 shadow-lg"
          role="menu"
        >
          {#if count === 1}
            {#if !presentation}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-elevated"
                role="menuitem"
                onclick={() => runMenuAction(onEdit)}
              >
                <CioPencil size={13} class="text-muted" />
                Edit
              </button>
              <div class="mx-2 my-1 border-t"></div>
            {/if}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-danger transition-colors hover:bg-danger/10"
              role="menuitem"
              onclick={() => runMenuAction(onDelete)}
            >
              <CioTrash size={13} />
              Delete
            </button>
          {:else}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-danger transition-colors hover:bg-danger/10"
              role="menuitem"
              onclick={() => runMenuAction(onDeleteAll)}
            >
              <CioTrash size={13} />
              Delete all ({count})
            </button>
          {/if}
        </div>
      {/if}
    </div>
    {#if count === 1}
      <CardButton
        label="Send now"
        title={`Send this message to the agent now (${steerModifierLabel}Enter) without waiting for the turn to end or for this device to free up`}
        icon={CioSend}
        size="xs"
        disabled={!hasQueuedPayload}
        onclick={onSteer}
      />
    {/if}
  {/snippet}

  {#snippet body()}
    <!-- The queue's own order, head first: the next message to send, then every
         message behind it. Reordering only writes the queue on release, so a
         gesture never changes what the dispatcher is about to send. -->
    <ol
      bind:this={listElement}
      class="flex flex-col px-3 py-2.5"
      aria-label="Queued messages, in the order they send"
    >
      {#each queue as row, index (row.id)}
        {@const held = drag.draggingId === row.id}
        <li
          class="relative flex items-start gap-1.5 {index > 0
            ? 'border-t border-border pt-2'
            : ''} {index < queue.length - 1 ? 'pb-2' : ''} {held
            ? 'z-10 bg-surface'
            : ''} {drag.dragging && !held ? 'transition-transform duration-150 ease-out' : ''}"
          data-queued-id={row.id}
          style:transform={drag.transformFor(index)}
        >
          <button
            type="button"
            class="mt-0.5 flex h-6 w-5 shrink-0 touch-none items-center justify-center transition-colors hover:text-foreground {held
              ? 'cursor-grabbing text-foreground'
              : 'cursor-grab text-dimmed'}"
            title="Reorder this queued message: drag the gripper, or press the arrow keys"
            aria-label={`Move queued message ${index + 1} of ${queue.length}. Drag the gripper, or press the up and down arrow keys.`}
            onpointerdown={(event: PointerEvent) => startDrag(event, row.id)}
            onkeydown={(event: KeyboardEvent) => moveWithKeyboard(event, row.id, index)}
          >
            <CioGrip size={12} />
          </button>
          <div class="min-w-0 flex-1">
            {#if index === 0}
              <div class="space-y-2">
                {#if resourceWait}
                  <div class="border border-warning/40 bg-warning/10 px-2 py-1.5">
                    <p class="text-[0.75rem] text-foreground">
                      Resumes when free CPU &gt; {formatPercent(CPU_AVAILABLE_FLOOR_PERCENT)} and free
                      RAM &gt;
                      {formatMemory(resourceWait.memoryFloorBytes)}.
                    </p>
                    <p class="pt-1 text-[0.6875rem] text-muted">
                      Now {formatPercent(resourceWait.cpuAvailablePercent)} CPU free · {formatMemory(
                        resourceWait.memoryAvailableBytes
                      )} RAM free
                    </p>
                  </div>
                {/if}
                {#if promptReferences.length > 0}
                  <div class="flex flex-wrap gap-1.5">
                    {#each promptReferences as reference (reference.id)}
                      <span
                        class="inline-flex max-w-full items-center gap-1.5 border border-accent/30 bg-accent/10 px-2 py-1 text-[0.75rem]"
                        title={reference.comment
                          ? `${reference.comment}\n\n${reference.text}`
                          : reference.text}
                      >
                        <CioMessage size={11} class="shrink-0 text-accent" />
                        <span class="font-medium text-foreground">{reference.label}</span>
                        <span class="max-w-56 truncate text-muted">{reference.text}</span>
                        {#if reference.comment}
                          <span class="max-w-48 truncate italic text-foreground">
                            “{reference.comment}”
                          </span>
                        {/if}
                      </span>
                    {/each}
                  </div>
                {/if}

                {#if startAfterThreads.length > 0}
                  <div class="flex flex-col gap-0.5">
                    {#each startAfterThreads as dependency (dependency.id)}
                      <div
                        class="flex w-full items-center gap-1 px-1.5 py-1 transition-colors hover:bg-elevated"
                        role="group"
                        onmouseenter={() => onPreloadStartAfter(dependency.id)}
                      >
                        <CioClock size={12} class="shrink-0 text-info" />
                        <button
                          type="button"
                          class="min-w-0 flex-1 truncate text-left text-[0.75rem] text-info"
                          title={`Open ${dependency.title}`}
                          aria-label={`Open ${dependency.title}`}
                          onclick={() => onOpenStartAfter(dependency.id)}
                        >
                          {dependency.title}
                        </button>
                        <button
                          type="button"
                          class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
                          title={`Remove ${dependency.title} from Starts after`}
                          aria-label={`Remove ${dependency.title} from Starts after`}
                          onclick={() => onRemoveStartAfter(dependency)}
                        >
                          <CioTrash size={12} />
                        </button>
                        <button
                          type="button"
                          class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                          title={`Open ${dependency.title}`}
                          aria-label={`Open ${dependency.title}`}
                          onclick={() => onOpenStartAfter(dependency.id)}
                        >
                          <CioArrowUpRight size={12} />
                        </button>
                      </div>
                    {/each}
                  </div>
                {/if}

                {#if attachments.length > 0}
                  <div class="flex flex-wrap gap-1.5">
                    {#each attachments as file (file.url)}
                      <AttachmentPill
                        attachment={file}
                        previewUrl={previewUrls[file.url]}
                        onPreview={onPreviewAttachment}
                      />
                    {/each}
                  </div>
                {/if}

                {#if presentation}
                  <div>
                    <p class="text-[0.75rem] italic text-dimmed">{presentation.action}</p>
                    {#if presentation.body}
                      <p class="mt-1 text-[0.75rem] text-muted line-clamp-3">{presentation.body}</p>
                    {/if}
                  </div>
                {:else if text.trim().length > 0}
                  <p class="text-[0.75rem] text-muted line-clamp-3">{text}</p>
                {/if}
              </div>
            {:else}
              <!-- A message behind the head says what it will send and what
                   holds it back, without opening its whole payload here. -->
              <div class="flex items-start gap-1.5 text-[0.75rem] text-muted">
                <span class="line-clamp-2 min-w-0 flex-1">
                  {#if row.text.trim().length > 0}
                    {row.text}
                  {:else}
                    <span class="italic text-dimmed">Carries files or context only</span>
                  {/if}
                </span>
                {#if row.waitsOn > 0}
                  <span
                    class="flex shrink-0 items-center gap-0.5 border border-border px-1 text-[0.625rem] text-info"
                    title={`Waits on ${row.waitsOn} ${
                      row.waitsOn === 1 ? 'thread' : 'threads'
                    } before it sends`}
                  >
                    <CioClock size={10} />
                    {row.waitsOn}
                    <span class="sr-only">
                      {row.waitsOn === 1 ? 'thread' : 'threads'} to finish
                    </span>
                  </span>
                {/if}
                {#if row.attachments > 0}
                  <span
                    class="flex shrink-0 items-center gap-0.5 border border-border px-1 text-[0.625rem] text-dimmed"
                    title={`${row.attachments} ${
                      row.attachments === 1 ? 'attachment' : 'attachments'
                    }`}
                  >
                    <CioPaperclip size={10} />
                    {row.attachments}
                    <span class="sr-only">attachments</span>
                  </span>
                {/if}
              </div>
            {/if}
          </div>
          {#if count > 1}
            <!-- With more than one message waiting, each row owns its actions:
                 it can send itself now without sending the rest, and its own
                 menu edits or deletes just this row. The head's Send now is
                 gone, so no button ever drains the whole queue at once. -->
            <div class="flex shrink-0 items-start gap-0.5">
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                title="Send this message now, without sending the rest of the queue"
                aria-label={`Send queued message ${index + 1} of ${queue.length} now`}
                onclick={() => onSendQueued(row.id)}
              >
                <CioSend size={12} />
              </button>
              <div class="relative">
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  title={`Actions for queued message ${index + 1}`}
                  aria-label={`Actions for queued message ${index + 1} of ${queue.length}`}
                  aria-haspopup="menu"
                  aria-expanded={rowMenuOpenId === row.id}
                  onclick={() => toggleRowMenu(row.id)}
                  oncontextmenu={(event: MouseEvent) => {
                    event.preventDefault()
                    queueMenuOpen = false
                    rowMenuOpenId = row.id
                  }}
                >
                  <CioEllipsis size={12} />
                </button>
                {#if rowMenuOpenId === row.id}
                  <button
                    type="button"
                    class="fixed inset-0 z-50 cursor-default"
                    aria-label="Close menu"
                    onclick={() => (rowMenuOpenId = null)}
                  ></button>
                  <div
                    class="absolute right-0 top-7 z-50 w-32 border border-border-strong bg-surface p-1 shadow-lg"
                    role="menu"
                  >
                    {#if !(row.hasPresentation || (index === 0 && presentation))}
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-elevated"
                        role="menuitem"
                        onclick={() => {
                          rowMenuOpenId = null
                          onEditQueued(row.id)
                        }}
                      >
                        <CioPencil size={13} class="text-muted" />
                        Edit
                      </button>
                      <div class="mx-2 my-1 border-t"></div>
                    {/if}
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-danger transition-colors hover:bg-danger/10"
                      role="menuitem"
                      onclick={() => {
                        rowMenuOpenId = null
                        onDeleteQueued(row.id)
                      }}
                    >
                      <CioTrash size={13} />
                      Delete
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/snippet}
</CardStack>
