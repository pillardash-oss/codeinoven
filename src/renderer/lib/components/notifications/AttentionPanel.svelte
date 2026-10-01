<script lang="ts">
  import { Check, MessageSquare, TriangleAlert, X } from '@lucide/svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { attentionState } from '$lib/stores/attention.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { formatDateTime } from '$shared/date-time-format'
  import {
    describeRelativeTime,
    type AutoAnswerItem,
    type AutoAnswerThreadScope
  } from '$shared/types'

  interface Props {
    /** The conversation this panel was opened for. */
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  /** How each kind of auto-resolved gate reads in the panel. */
  const KIND_LABELS: Record<AutoAnswerItem['kind'], string> = {
    question: 'Question auto-answered',
    secret: 'Secret request expired',
    'image-descriptor': 'Image decision timed out',
    'scope-confirmation': 'Destructive action auto-cancelled'
  }

  let busyId = $state<string | null>(null)

  /**
   * What this panel is showing. The gate is keyed to the conversation on screen,
   * and through it to the assistant task it ran for and the routine that owns
   * that task, so a decision made on a scheduled run thread is still visible on
   * the task's own thread.
   */
  const scope = $derived.by((): AutoAnswerThreadScope => {
    const thread = workspaceState.selectedThread
    const matches = thread !== null && thread.id === threadId && thread.projectId === projectId
    return {
      id: threadId,
      projectId,
      ...(matches && thread.routineId ? { routineId: thread.routineId } : {}),
      ...(matches && thread.assistantTaskId ? { assistantTaskId: thread.assistantTaskId } : {})
    }
  })

  let unread = $derived(attentionState.unreadFor(scope))

  /**
   * The panel exists only while its scope has decisions to show. Reading the last
   * one clears the rail icon (the rail item is keyed to the same scope), so the
   * panel leaves with it instead of sitting on its empty state. Both dismiss
   * actions mark their record read before they answer main, so this reflects the
   * new list immediately.
   */
  function closeIfEmpty(): void {
    if (attentionState.unreadFor(scope).length === 0) contextSidebarState.closeAttention()
  }

  /** The resolved title of the thread the gate belongs to, or a plain fallback
   *  when that thread has since been deleted. */
  function threadTitle(threadId: string): string {
    return scopeState.allScopeThreads.find((thread) => thread.id === threadId)?.title ?? 'Thread'
  }

  /** What the app settled on when it chose nothing. The wording follows the
   *  gate: a secret card was closed, an image decision was dropped, and a
   *  question simply went unanswered. */
  function unansweredText(item: AutoAnswerItem): string {
    if (item.kind === 'secret') return 'Closed unanswered'
    if (item.kind === 'image-descriptor') return 'Timed out with no choice'
    return 'No answer'
  }

  async function openThread(item: AutoAnswerItem): Promise<void> {
    busyId = item.id
    try {
      const [project, thread] = await Promise.all([
        invoke('project:get', item.projectId),
        invoke('thread:get', item.projectId, item.threadId)
      ])
      if (!project || !thread) return
      const openDesktopThread = workspaceState.openThreadFromNotification
      if (!openDesktopThread) return
      await openDesktopThread(thread, project)
    } catch {
      // The thread or its project may have been deleted since the gate resolved.
    } finally {
      busyId = null
    }
  }

  function dismiss(item: AutoAnswerItem): void {
    void attentionState.dismiss(item.id)
    closeIfEmpty()
  }

  function dismissAll(): void {
    void attentionState.dismissAll()
    closeIfEmpty()
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
    <TriangleAlert size={14} class="shrink-0 text-warning" />
    <span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
      Decisions made for you
    </span>
    {#if unread.length > 1}
      <button
        type="button"
        class="shrink-0 rounded-lg px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Dismiss all decisions"
        title="Dismiss all decisions"
        onclick={dismissAll}
      >
        Dismiss all
      </button>
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if unread.length === 0}
      <div class="flex h-full min-h-0 flex-col">
        <EmptyState
          icon={TriangleAlert}
          title="Nothing resolved for you on this thread"
          description="When a question, secret request, image decision, or destructive confirmation on this thread is settled without you, it is recorded here so the app never answers silently."
        />
      </div>
    {:else}
      <ul class="flex flex-col divide-y divide-border">
        {#each unread as item (item.id)}
          <li class="flex flex-col gap-2 px-3 py-3">
            <div class="flex items-start gap-2">
              <div class="min-w-0 flex-1">
                <p class="text-xs font-semibold text-foreground">{KIND_LABELS[item.kind]}</p>
                <p
                  class="mt-0.5 truncate text-[0.6875rem] text-muted"
                  title={threadTitle(item.threadId)}
                >
                  {threadTitle(item.threadId)}
                </p>
                <p class="mt-0.5 text-[0.625rem] text-dimmed" title={formatDateTime(item.at)}>
                  {describeRelativeTime(item.at, Date.now())}
                </p>
              </div>
              <button
                type="button"
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Open the thread this decision belongs to"
                title="Open the thread this decision belongs to"
                disabled={busyId === item.id}
                onclick={() => void openThread(item)}
              >
                <MessageSquare size={13} />
              </button>
              <button
                type="button"
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
                aria-label="Dismiss this decision"
                title="Dismiss this decision"
                onclick={() => dismiss(item)}
              >
                <X size={13} />
              </button>
            </div>

            <div class="flex flex-col gap-2">
              {#each item.entries as entry, entryIndex (entryIndex)}
                <div class="rounded-lg border border-border bg-surface px-2.5 py-2">
                  {#if entry.header}
                    <p class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">
                      {entry.header}
                    </p>
                  {/if}
                  <p class="text-[0.6875rem] leading-relaxed text-foreground">{entry.prompt}</p>

                  {#if entry.options.length > 0}
                    <ul class="mt-1.5 flex flex-col gap-0.5">
                      {#each entry.options as option, optionIndex (optionIndex)}
                        <li
                          class="flex items-start gap-1.5 text-[0.6875rem] {option === entry.picked
                            ? 'font-semibold text-warning'
                            : 'text-muted'}"
                        >
                          {#if option === entry.picked}
                            <Check size={11} class="mt-0.5 shrink-0" />
                          {:else}
                            <span class="mt-0.5 h-[11px] w-[11px] shrink-0" aria-hidden="true"
                            ></span>
                          {/if}
                          <span class="min-w-0">{option}</span>
                        </li>
                      {/each}
                    </ul>
                  {/if}

                  {#if entry.picked === null}
                    <p class="mt-1.5 text-[0.6875rem] font-medium text-warning">
                      {unansweredText(item)}
                    </p>
                  {/if}
                </div>
              {/each}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
