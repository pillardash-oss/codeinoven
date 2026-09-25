<script lang="ts">
  import { CheckCircle2, ExternalLink, Eye } from '@lucide/svelte'
  import type { PullRequestReference } from '$shared/types'

  interface Props {
    result: PullRequestReference
    onView: () => void
    onOpenBrowser: (url: string) => void
  }

  let { result, onView, onOpenBrowser }: Props = $props()
</script>

<div
  class="w-full max-w-sm rounded-xl border border-success/30 bg-success/10 px-6 py-7 text-center"
>
  <div
    class="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-success/15 text-success"
  >
    <CheckCircle2 size={24} aria-hidden="true" />
  </div>
  <p class="mt-3 text-sm font-semibold text-success">Pull request #{result.number} created</p>
  <p class="mt-1 truncate text-[0.6875rem] text-muted">{result.title}</p>
  <div class="mt-5 flex items-center justify-center gap-2">
    <button
      type="button"
      class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover"
      title="Open this pull request in the Git panel"
      onclick={onView}
    >
      <Eye size={12} />
      View PR
    </button>
    <button
      type="button"
      class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated"
      title="Open this pull request on GitHub"
      data-external-url={result.url}
      onclick={() => onOpenBrowser(result.url)}
    >
      <ExternalLink size={12} />
      Open in browser
    </button>
  </div>
</div>
