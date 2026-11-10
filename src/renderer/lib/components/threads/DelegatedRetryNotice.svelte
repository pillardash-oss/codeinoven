<script lang="ts">
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  import type { DelegatedAttentionEntry } from '$shared/delegated-attention'

  interface Props {
    retry: NonNullable<DelegatedAttentionEntry['retry']>
  }

  let { retry }: Props = $props()

  /** A wait that resumes on its own says when; a wait only a person ends says so. */
  const resumes = $derived(
    retry.retryAt === undefined
      ? 'It continues as soon as the provider is available again.'
      : `It retries on its own at ${new Date(retry.retryAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit'
        })}.`
  )

  const reason = $derived(
    retry.issueKind === 'rate_limit'
      ? 'The provider is rate limiting this thread.'
      : retry.issueKind === 'quota' || retry.issueKind === 'billing'
        ? 'The account is out of credit for this model.'
        : retry.issueKind === 'authentication'
          ? 'The provider refused the credentials.'
          : retry.issueKind === 'network'
            ? 'The connection dropped.'
            : 'The provider is not available right now.'
  )
</script>

<!-- A parked thread, reported as a reply instead of as silence: the conversation
     that started the work has to be able to tell waiting apart from running. -->
<div class="flex items-start gap-2 text-[0.75rem] text-muted">
  <span class="mt-0.5 shrink-0 text-warning" aria-hidden="true">
    <CioClock size={13} />
  </span>
  <div class="min-w-0 space-y-1">
    <p class="text-foreground">Paused and waiting to continue.</p>
    <p>{reason} {resumes}</p>
    {#if retry.message.trim().length > 0}
      <p class="truncate text-dimmed" title={retry.message}>{retry.message}</p>
    {/if}
  </div>
</div>
