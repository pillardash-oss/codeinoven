<script lang="ts">
  import { ChevronRight, Loader2, TriangleAlert } from '@lucide/svelte'
  import { parseJobLogSections, type JobLogLine, type JobLogSection } from '$shared/github-job-log'
  import type { GitHubDeploymentJobLog } from '$shared/types'

  interface Props {
    log: GitHubDeploymentJobLog | null
    loading?: boolean
    error?: string
    /** The job's failed steps, so its steps can be matched to the log's own sections. */
    failedSteps?: readonly string[]
    /** Height and padding for the pane, which each surface sizes to its own column. */
    class?: string
  }

  let {
    log,
    loading = false,
    error = '',
    failedSteps = [],
    class: paneClass = ''
  }: Props = $props()

  /** Rendered for blank lines, which a log uses as spacing and a `<p>` would swallow. */
  const NBSP = '\u00a0'

  const sections = $derived(log === null ? [] : parseJobLogSections(log.log, { failedSteps }))
  /** One flat block of text is not worth wrapping in a single collapsible header. */
  const grouped = $derived(sections.some((section) => section.kind === 'group'))
  const hasFailure = $derived(sections.some((section) => section.failed))
  /**
   * Only what the user has toggled. Everything else follows the log: a failing job
   * opens on the step that failed, and a passing one opens on everything, since
   * there is no failure to steer by.
   */
  let overrides = $state<Record<string, boolean>>({})
  const logId = $derived(log?.jobId ?? 0)

  function openByDefault(section: JobLogSection): boolean {
    if (section.lines.length === 0) return false
    return hasFailure ? section.failed : true
  }

  function isOpen(section: JobLogSection): boolean {
    return overrides[`${logId}:${section.id}`] ?? openByDefault(section)
  }

  function toggle(section: JobLogSection): void {
    overrides = { ...overrides, [`${logId}:${section.id}`]: !isOpen(section) }
  }
</script>

{#snippet logLine(entry: JobLogLine)}
  {#if entry.kind === 'omitted'}
    <p
      class="my-1 rounded border border-dashed border-border px-2 py-1 text-center text-[0.5625rem] text-dimmed"
    >
      {entry.text}
    </p>
  {:else}
    <p
      class="whitespace-pre-wrap break-words {entry.kind === 'error'
        ? 'text-danger'
        : entry.kind === 'warning'
          ? 'text-warning'
          : ''}"
    >
      {entry.text || NBSP}
    </p>
  {/if}
{/snippet}

<div class={paneClass}>
  {#if loading}
    <div class="flex items-center gap-2 text-[0.625rem] text-dimmed">
      <Loader2 size={11} class="shrink-0 animate-spin" />
      Loading log…
    </div>
  {:else if error}
    <p class="rounded-md bg-danger/10 px-2 py-1.5 text-[0.625rem] text-danger">{error}</p>
  {:else if log && grouped}
    <!--
      One row per step, the way GitHub presents a job: the failure is the thing
      being looked for, so the step that failed opens and the setup noise stays shut.
    -->
    <div class="flex flex-col gap-1 font-mono text-[0.5625rem] leading-relaxed text-muted">
      {#each sections as section (section.id)}
        {@const open = isOpen(section)}
        <div class="overflow-hidden rounded-md border border-border/60">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-elevated {section.failed
              ? 'bg-danger/10'
              : 'bg-elevated/40'}"
            title="{open ? 'Hide' : 'Show'} the {section.title} output"
            aria-expanded={open}
            onclick={() => toggle(section)}
          >
            <ChevronRight
              size={11}
              class="shrink-0 text-dimmed transition-transform {open ? 'rotate-90' : ''}"
            />
            {#if section.failed}
              <TriangleAlert size={11} class="shrink-0 text-danger" />
            {/if}
            <span
              class="min-w-0 flex-1 truncate text-[0.625rem] {section.failed
                ? 'font-medium text-danger'
                : 'text-muted'}"
            >
              {section.title}
            </span>
            {#if section.errorCount > 0}
              <span class="shrink-0 text-[0.5625rem] text-danger">
                {section.errorCount}
                {section.errorCount === 1 ? 'error' : 'errors'}
              </span>
            {/if}
            {#if section.warningCount > 0}
              <span class="shrink-0 text-[0.5625rem] text-warning">
                {section.warningCount}
                {section.warningCount === 1 ? 'warning' : 'warnings'}
              </span>
            {/if}
            <span class="shrink-0 text-[0.5625rem] tabular-nums text-dimmed">
              {section.lines.length}
              {section.lines.length === 1 ? 'line' : 'lines'}
            </span>
          </button>
          {#if open}
            <div class="border-t border-border/60 px-2 py-1.5">
              {#each section.lines as entry, index (index)}
                {@render logLine(entry)}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else if log}
    <div class="font-mono text-[0.5625rem] leading-relaxed text-muted">
      {#each sections as section (section.id)}
        {#each section.lines as entry, index (index)}
          {@render logLine(entry)}
        {/each}
      {/each}
    </div>
  {/if}
  {#if log?.truncated}
    <p class="mt-1 text-[0.5625rem] text-dimmed">
      This log is longer than the in-app limit, so the middle was dropped. Open it on GitHub for the
      whole thing.
    </p>
  {/if}
</div>
