<script lang="ts">
  import { Info, TriangleAlert } from '@lucide/svelte'
  import { noticeDismissals } from '$lib/stores/notice-dismissals.svelte'
  import NoticeDismissButton from '../ui/NoticeDismissButton.svelte'

  interface Props {
    head: string
    base: string
    createError: string
    createErrorIsNoCommits: boolean
  }

  let { head, base, createError, createErrorIsNoCommits }: Props = $props()

  /**
   * Both notices describe the same failed attempt to open a pull request, so they
   * share one key and one signature: dismissing either hides the failure the
   * user has read, and a different error (or a different branch pair) raises its
   * own notice rather than hiding under the old dismissal.
   */
  const noticeId = $derived(`pr.create:${head}->${base}`)
  const noticeCondition = $derived(createError)
</script>

{#if createError && createErrorIsNoCommits && !noticeDismissals.isDismissed(noticeId, noticeCondition)}
  <div
    class="flex items-start gap-2 rounded-lg border border-border bg-elevated px-3 py-2.5"
    role="status"
  >
    <Info size={14} class="mt-0.5 shrink-0 text-dimmed" />
    <div class="min-w-0 flex-1">
      <p class="text-[0.625rem] font-semibold text-foreground">Nothing to merge</p>
      <p class="mt-0.5 text-[0.5625rem] leading-relaxed text-dimmed">
        <span class="font-medium text-foreground">{head}</span> is already up to date with
        <span class="font-medium text-foreground">{base}</span> there are no commits left to open a pull
        request for. It was likely merged elsewhere while this panel was open.
      </p>
    </div>
    <NoticeDismissButton
      id={noticeId}
      condition={noticeCondition}
      title="Dismiss the nothing to merge notice"
    />
  </div>
{:else if createError && !noticeDismissals.isDismissed(noticeId, noticeCondition)}
  <div class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2.5" role="alert">
    <div class="flex items-start gap-2">
      <TriangleAlert size={14} class="mt-0.5 shrink-0 text-danger" />
      <div class="min-w-0 flex-1">
        <p class="text-[0.625rem] font-semibold text-danger">Pull request was not created</p>
        <p
          class="mt-0.5 whitespace-pre-wrap break-words text-[0.5625rem] leading-relaxed text-danger"
        >
          {createError}
        </p>
        <p class="mt-1 text-[0.5625rem] leading-relaxed text-dimmed">
          Fix the Git error, then choose Create pull request to try again.
        </p>
      </div>
      <NoticeDismissButton
        id={noticeId}
        condition={noticeCondition}
        title="Dismiss the pull request error"
        tone="danger"
      />
    </div>
  </div>
{/if}
