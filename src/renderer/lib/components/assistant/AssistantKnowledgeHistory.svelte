<script lang="ts">
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import Modal from '../ui/Modal.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { assistants } from '$lib/stores/assistants.svelte'
  import { formatDateTime, formatDateTimeCompact } from '$shared/date-time-format'
  import { describeRelativeTime, type AssistantKnowledgeRevision } from '$shared/types'

  /**
   * The versions of an assistant's instructions.
   *
   * Knowledge is not edited a line at a time, it is replaced whole on every save,
   * so a save that lost the page looks exactly like a save that tightened a
   * sentence: the document is new either way. This is where the old documents are.
   * Each version states when it was saved, how big it is, and its first line, and
   * opening one reads it in full before deciding to put it back.
   *
   * Restoring never removes a version. It writes the chosen document as the newest
   * one, so the version it replaces stays in the list and the timeline can be
   * stepped back and forth rather than only rewound.
   */
  interface Props {
    /** The assistant whose history this is. */
    assistantId: string
    /** Its name, for the restore confirmation and the toast. */
    assistantName: string
    onClose: () => void
  }

  let { assistantId, assistantName, onClose }: Props = $props()

  let revisions = $state<AssistantKnowledgeRevision[]>([])
  let loading = $state(true)
  let loadError = $state<string | null>(null)
  /** The version whose text is open, and the text once it has arrived. */
  let expandedId = $state<string | null>(null)
  let expandedText = $state<{ id: string; knowledge: string } | null>(null)
  let expandedLoading = $state(false)
  /** The version waiting on the restore confirmation. */
  let restoreTarget = $state<AssistantKnowledgeRevision | null>(null)
  let restoring = $state(false)

  /** The version the assistant is running right now: the newest one saved. */
  const currentId = $derived(revisions[0]?.id ?? null)
  const currentLines = $derived(revisions[0]?.lines ?? 0)

  /** What a version is, in the words the panel uses for a save. */
  function causeLabel(revision: AssistantKnowledgeRevision): string {
    if (revision.label) return revision.label
    if (revision.cause === 'setup') return 'First instructions'
    if (revision.cause === 'restore') return 'Restored instructions'
    return 'Edited instructions'
  }

  async function load(): Promise<void> {
    loading = true
    loadError = null
    try {
      revisions = await assistants.listKnowledgeRevisions(assistantId)
    } catch (error) {
      loadError = 'The instruction history could not be read.'
      reportError(error, loadError)
    } finally {
      loading = false
    }
  }

  /**
   * Open one version's text. Read on demand: a list of every document at once is
   * the whole history in memory for a reader who asked about one entry.
   */
  async function toggle(revision: AssistantKnowledgeRevision): Promise<void> {
    if (expandedId === revision.id) {
      expandedId = null
      return
    }
    expandedId = revision.id
    if (expandedText?.id === revision.id) return
    expandedText = null
    expandedLoading = true
    try {
      const detail = await assistants.getKnowledgeRevision(assistantId, revision.id)
      if (expandedId !== revision.id) return
      expandedText = detail ? { id: detail.id, knowledge: detail.knowledge } : null
    } catch (error) {
      reportError(error, 'This version of the instructions could not be read')
      expandedId = null
    } finally {
      expandedLoading = false
    }
  }

  async function confirmRestore(): Promise<void> {
    const target = restoreTarget
    if (!target || restoring) return
    restoring = true
    try {
      await assistants.restoreKnowledgeRevision(assistantId, target.id)
      toast.success(`${assistantName}'s instructions restored`)
      restoreTarget = null
      expandedId = null
      expandedText = null
      await load()
    } catch (error) {
      reportError(error, 'The instructions could not be restored')
    } finally {
      restoring = false
    }
  }

  onMount(() => {
    void load()
  })
</script>

<Modal
  open
  title="Instruction history"
  description="Every saved version of this assistant's instructions, newest first."
  size="lg"
  {onClose}
>
  <div class="flex flex-col gap-2.5 px-4 py-3">
    <p class="text-xs leading-relaxed text-muted">
      Instructions are replaced in full each time they are saved, so this list is every version
      {assistantName} has run with. Restoring one writes it back as the newest version, and keeps the
      one it replaces.
    </p>

    {#if loading}
      <p class="px-1 py-6 text-center text-xs text-dimmed">Reading the history…</p>
    {:else if loadError}
      <p class="border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        {loadError}
      </p>
    {:else if revisions.length === 0}
      <div class="border border-border bg-surface px-3 py-6 text-center">
        <p class="text-xs font-medium text-foreground">No versions yet</p>
        <p class="mx-auto mt-1 max-w-[22rem] text-xs leading-relaxed text-muted">
          The first save of {assistantName}'s instructions is the first entry here. Every later save
          adds one, so nothing written today has to be lost tomorrow.
        </p>
      </div>
    {:else}
      <div class="border border-border">
        {#each revisions as revision (revision.id)}
          {@const isCurrent = revision.id === currentId}
          {@const expanded = expandedId === revision.id}
          <div class="border-b border-border last:border-b-0">
            <div class="flex items-start gap-1.5 px-2.5 py-2">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-start gap-1.5 text-left"
                aria-expanded={expanded}
                title={expanded ? 'Fold this version' : 'Read this version in full'}
                onclick={() => void toggle(revision)}
              >
                <CioForward
                  size={12}
                  strokeWidth={1.8}
                  class="mt-0.5 shrink-0 text-dimmed transition-transform duration-150 {expanded
                    ? 'rotate-90'
                    : ''}"
                />
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="flex items-center gap-1.5">
                    <span class="min-w-0 truncate text-xs text-foreground">
                      {causeLabel(revision)}
                    </span>
                    {#if isCurrent}
                      <span
                        class="shrink-0 border border-border px-1 py-px text-[0.5625rem] tracking-wide text-dimmed uppercase"
                        title="The instructions {assistantName} runs with now"
                      >
                        Current
                      </span>
                    {/if}
                  </span>
                  <span class="text-[0.625rem] text-dimmed">
                    {formatDateTime(revision.createdAt)} · {describeRelativeTime(
                      revision.createdAt,
                      Date.now()
                    )} · {revision.lines}
                    {revision.lines === 1 ? 'line' : 'lines'}
                  </span>
                  {#if revision.excerpt}
                    <span class="truncate text-[0.6875rem] text-muted">{revision.excerpt}</span>
                  {/if}
                </span>
              </button>
              {#if !isCurrent}
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  title="Restore the version from {formatDateTimeCompact(revision.createdAt)}"
                  aria-label="Restore the version from {formatDateTimeCompact(revision.createdAt)}"
                  onclick={() => (restoreTarget = revision)}
                >
                  <CioUndo size={12} strokeWidth={1.8} />
                </button>
              {/if}
            </div>

            {#if expanded}
              <div class="border-t border-border bg-surface px-3 py-2">
                {#if expandedLoading && expandedText?.id !== revision.id}
                  <p class="text-[0.6875rem] text-dimmed">Reading…</p>
                {:else if expandedText?.id === revision.id}
                  <div class="max-h-72 overflow-y-auto text-xs leading-relaxed text-muted">
                    <MarkdownView text={expandedText.knowledge} />
                  </div>
                {:else}
                  <p class="text-[0.6875rem] text-dimmed">This version could not be read.</p>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <div class="mr-auto">
      <button
        type="button"
        class="border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Close the instruction history"
        onclick={onClose}
      >
        Close
      </button>
    </div>
  {/snippet}
</Modal>

<ConfirmDialog
  open={restoreTarget !== null}
  title="Restore these instructions?"
  confirmLabel="Restore version"
  cancelLabel="Keep current"
  busy={restoring}
  onCancel={() => (restoreTarget = null)}
  onConfirm={confirmRestore}
>
  <p>
    Write the version saved on
    <strong class="text-foreground">
      {restoreTarget ? formatDateTime(restoreTarget.createdAt) : ''}
    </strong>
    back as {assistantName}'s instructions?
  </p>
  <p class="mt-2">
    It holds {restoreTarget?.lines ?? 0} lines and replaces the {currentLines} saved now. What is replaced
    stays in the history, so this can be undone the same way.
  </p>
</ConfirmDialog>
