<script lang="ts">
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import type { PullRequestSummary } from '$shared/types'

  /**
   * The confirmation a lifecycle batch runs through, and nothing else.
   *
   * It names the count and the numbers, because closing twenty pull requests from a
   * list is one keystroke away from closing twenty-one and there is no undo. It is
   * also where the optional note is written: one line saying why, the same line on
   * every one of them, is what a swept backlog needs to explain itself, and typing
   * it twenty times is the reason a sweep turns into twenty individual closes. The
   * note is posted before the close it belongs to, so a pull request whose note
   * failed stays open rather than becoming a closed row that gives no reason.
   *
   * The run itself is not reported here. A batch is minutes of round trips, so it
   * leaves with the confirmation and reports through the docked job panel
   * (`PrBatchJobPanel`), which is what lets the user keep working instead of
   * watching a modal. This dialog is unmounted the moment the user confirms.
   */
  interface Props {
    batch: { mode: 'close' | 'reopen'; targets: PullRequestSummary[] }
    /** Hand the confirmed batch over; the caller starts the job and dismisses this. */
    onConfirm: (comment: string | null) => void
    onClose: () => void
  }

  let { batch, onConfirm, onClose }: Props = $props()

  /** The note every pull request in this batch receives, posted verbatim. */
  let comment = $state('')
  /**
   * Field id suffix. Two panels can be mounted at once, and an id has to name one
   * element, so the label's `for` is scoped to this instance.
   */
  const fieldSuffix = Math.random().toString(36).slice(2)

  const targets = $derived(batch.targets)
  const mode = $derived(batch.mode)

  const verb = $derived(mode === 'close' ? 'Close' : 'Reopen')
  const pastVerb = $derived(mode === 'close' ? 'closed' : 'reopened')
  /** The trimmed note, which is what travels: whitespace is not a comment. */
  const note = $derived(comment.trim())
  const title = $derived(
    targets.length === 1
      ? `${verb} pull request #${targets[0]?.number}?`
      : `${verb} ${targets.length} pull requests?`
  )

  /** Numbers named in full up to a bound, then counted: a dialog is not a log. */
  const LIST_LIMIT = 12
  const namedNumbers = $derived(targets.slice(0, LIST_LIMIT))
  const unlistedNumbers = $derived(targets.length - namedNumbers.length)

  function describe(target: PullRequestSummary): string {
    return `#${target.number}`
  }

  function confirm(): void {
    onConfirm(note.length > 0 ? note : null)
  }
</script>

<ConfirmDialog open {title} confirmLabel={verb} onCancel={onClose} onConfirm={confirm}>
  <p>
    {#if targets.length === 1}
      <strong class="text-foreground">{targets[0]?.title}</strong>
      {mode === 'close'
        ? ' will be closed without merging. You can reopen it from this list.'
        : ' will be reopened.'}
    {:else}
      {targets.length} pull requests will be {pastVerb}
      {mode === 'close' ? ' without merging' : ''}. You can change their state again from this list.
    {/if}
  </p>
  <p class="font-mono text-[0.6875rem] leading-relaxed text-dimmed">
    {namedNumbers.map(describe).join(', ')}{unlistedNumbers > 0
      ? ` and ${unlistedNumbers} more`
      : ''}
  </p>

  <div class="mt-3">
    <label
      class="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
      for="pr-batch-comment-{fieldSuffix}"
    >
      Comment (optional)
    </label>
    <textarea
      id="pr-batch-comment-{fieldSuffix}"
      class="min-h-16 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 text-xs leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
      placeholder={mode === 'close'
        ? 'Why these are being closed, e.g. superseded by a single dependency bump'
        : 'Why these are being reopened'}
      bind:value={comment}></textarea>
    <p class="mt-1 text-[0.625rem] leading-relaxed text-dimmed">
      {#if note.length > 0}
        Posted verbatim on all {targets.length} pull requests, before each one is {pastVerb}. A pull
        request whose comment fails is left untouched, so retrying cannot post the same note twice.
      {:else}
        Leave this empty to {mode === 'close' ? 'close' : 'reopen'} them with no comment.
      {/if}
    </p>
  </div>

  <p class="mt-3 text-[0.625rem] leading-relaxed text-dimmed">
    This runs in the background: a panel reports each pull request as it lands, and you can keep
    working while it does.
  </p>
</ConfirmDialog>
