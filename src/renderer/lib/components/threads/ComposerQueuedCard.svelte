<script lang="ts">
  import {
    ArrowUpRight,
    Clock,
    Ellipsis,
    MessageSquare,
    Pencil,
    Plus,
    Send,
    Trash2
  } from '@lucide/svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardStack from '../shared/CardStack.svelte'
  import CardTag from '../shared/CardTag.svelte'
  import type { StartAfterThreadReference } from '$lib/stores/renderer-recovery'
  import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'
  import type { UserMessagePresentation } from '$shared/types'

  interface Props {
    /** The message waiting behind the running turn. */
    text: string
    /** True when the queued payload carries attachments or context but no text. */
    hasContent: boolean
    /** How many messages wait in the thread's FIFO queue. */
    count: number
    /** The rest of the queue, listed under the head entry. */
    next: { id: string; text: string }[]
    /** Selections the queued message answers. */
    promptReferences: ResponseReferenceAnchor[]
    /** A presentation the queued message carries instead of plain text. */
    presentation: UserMessagePresentation | undefined
    /** Threads the queued message waits for before it sends. */
    startAfterThreads: StartAfterThreadReference[]
    /** The steer combo, so the send-now action names the key that does it. */
    steerModifierLabel: string
    /** Folds the card down to its head while a message waits. */
    folded?: boolean
    onSteer: () => void
    onEdit: () => void
    onDelete: () => void
    onDeleteAll: () => void
    onAddStartAfter: () => void
    onRemoveStartAfter: (dependency: StartAfterThreadReference) => void
    onOpenStartAfter: (threadId: string) => void
    onPreloadStartAfter: (threadId: string) => void
  }

  let {
    text,
    hasContent,
    count,
    next,
    promptReferences,
    presentation,
    startAfterThreads,
    steerModifierLabel,
    folded = $bindable(false),
    onSteer,
    onEdit,
    onDelete,
    onDeleteAll,
    onAddStartAfter,
    onRemoveStartAfter,
    onOpenStartAfter,
    onPreloadStartAfter
  }: Props = $props()

  let queueMenuOpen = $state(false)
  let hasQueuedPayload = $derived(text.trim().length > 0 || hasContent)

  /** The head names what is waiting: a count, a dependency, or one message. */
  const title = $derived(
    count > 1
      ? `Queued · ${count}`
      : startAfterThreads.length > 0
        ? 'Starts after'
        : 'Queued message'
  )
  /** The reading is a state, never an invented duration: the app keeps no
   *  timestamp for a queued message, so the chip says what is actually true. */
  const chip = $derived(
    count > 1
      ? { text: `${count} waiting`, tone: 'paused' as const }
      : startAfterThreads.length > 0
        ? { text: 'Waiting', tone: 'paused' as const }
        : undefined
  )

  function toggleQueueMenu(): void {
    queueMenuOpen = !queueMenuOpen
  }

  function runMenuAction(action: () => void): void {
    queueMenuOpen = false
    action()
  }
</script>

<!-- A message waiting behind the running turn. It stacks on the composer's top
edge, so it drops its own bottom rule and the composer's dashed top rule carries
the join. Its one action, Send now (the steer key), is a head control: a card
that only needs one action has no foot, and deleting the message already lives in
the head's menu. -->
<CardStack
  label="Queued message"
  icon={Clock}
  {title}
  {chip}
  foldLabel="queued message"
  bind:folded
>
  {#snippet meta()}
    {#if startAfterThreads.length === 0}
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
      <Plus size={13} />
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
        <Ellipsis size={13} />
      </button>
      {#if queueMenuOpen}
        <button
          type="button"
          class="fixed inset-0 z-30 cursor-default"
          aria-label="Close menu"
          onclick={() => (queueMenuOpen = false)}
        ></button>
        <div
          class="absolute bottom-8 right-0 z-40 w-36 border border-border-strong bg-surface p-1 shadow-lg"
          role="menu"
        >
          {#if !presentation}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-elevated"
              role="menuitem"
              onclick={() => runMenuAction(onEdit)}
            >
              <Pencil size={13} class="text-muted" />
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
            <Trash2 size={13} />
            Delete
          </button>
          {#if count > 1}
            <div class="mx-2 my-1 border-t"></div>
            <button
              type="button"
              class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-danger transition-colors hover:bg-danger/10"
              role="menuitem"
              onclick={() => runMenuAction(onDeleteAll)}
            >
              <Trash2 size={13} />
              Delete all ({count})
            </button>
          {/if}
        </div>
      {/if}
    </div>
    <CardButton
      label="Send now"
      title={`Send this message to the agent now (${steerModifierLabel}Enter) without waiting for the turn to end`}
      icon={Send}
      size="xs"
      disabled={!hasQueuedPayload}
      onclick={onSteer}
    />
  {/snippet}

  {#snippet body()}
    <div class="space-y-2 px-3 py-2.5">
      {#if promptReferences.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each promptReferences as reference (reference.id)}
            <span
              class="inline-flex max-w-full items-center gap-1.5 border border-accent/30 bg-accent/10 px-2 py-1 text-[0.75rem]"
              title={reference.comment
                ? `${reference.comment}\n\n${reference.text}`
                : reference.text}
            >
              <MessageSquare size={11} class="shrink-0 text-accent" />
              <span class="font-medium text-foreground">{reference.label}</span>
              <span class="max-w-56 truncate text-muted">{reference.text}</span>
              {#if reference.comment}
                <span class="max-w-48 truncate italic text-foreground">“{reference.comment}”</span>
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
              <Clock size={12} class="shrink-0 text-info" />
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
                <Trash2 size={12} />
              </button>
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
                title={`Open ${dependency.title}`}
                aria-label={`Open ${dependency.title}`}
                onclick={() => onOpenStartAfter(dependency.id)}
              >
                <ArrowUpRight size={12} />
              </button>
            </div>
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

      {#if next.length > 0}
        <div class="border-t border-border pt-2">
          <p class="text-[0.625rem] font-semibold tracking-[0.06em] uppercase text-dimmed">
            Next up
          </p>
          {#each next as entry (entry.id)}
            <p class="line-clamp-2 pt-1 text-[0.75rem] text-muted">{entry.text}</p>
          {/each}
        </div>
      {/if}
    </div>
  {/snippet}
</CardStack>
