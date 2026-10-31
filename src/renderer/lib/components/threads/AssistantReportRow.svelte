<script lang="ts">
  import CioFileText from '@pdslng/cio-icon/CioFileText.svelte'
  import { formatTime } from '$shared/date-time-format'
  import { revealCitationFile } from '$lib/reveal-file'
  import CardButton from '../shared/CardButton.svelte'

  interface Props {
    /** The name the run chose for the report it filed. */
    title: string
    /** Workspace-relative path of the filed Markdown file. */
    path: string
    /** When the report was filed. */
    at: number
    /** The conversation whose workspace the report lives in. */
    projectId?: string | null
  }

  let { title, path, at, projectId = null }: Props = $props()

  const filedAt = $derived(formatTime(at))

  function openReport(): void {
    if (!projectId) return
    void revealCitationFile(projectId, path)
  }
</script>

<div class="flex min-w-0 items-center gap-3 border border-border bg-surface px-3 py-2">
  <CioFileText size={16} strokeWidth={1.6} class="shrink-0 text-muted" />
  <div class="min-w-0 flex-1">
    <div class="truncate text-[0.8125rem] font-medium text-foreground">{title}</div>
    <div class="text-[0.75rem] text-dimmed">Report at {filedAt}</div>
  </div>
  <CardButton
    label="Open report"
    title={`Open the report ${title}`}
    variant="secondary"
    size="sm"
    onclick={openReport}
  />
</div>
