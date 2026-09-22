<script lang="ts">
  import {
    Bot,
    ChevronDown,
    ExternalLink,
    FileText,
    MessageSquare,
    MessagesSquare,
    Send
  } from '@lucide/svelte'
  import type { Attachment } from 'svelte/attachments'
  import { relativeTime } from '$lib/format/relative-time'
  import { openInBrowser } from '$lib/open-in-browser'
  import { revealCitationFile } from '$lib/reveal-file'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import type { PrAgentReport } from '$shared/types'

  /**
   * One agent assignment on a pull request: what it was asked, what it wrote back,
   * and every place that answer can be read from.
   *
   * The body is prose, so it is set as prose: the same markdown component and the
   * same reading step every comment in this reader uses, never a smaller step of
   * its own. It arrives folded to five lines, because one assignment can write
   * thousands of them and several assignments share this tab.
   *
   * The fold is measured rather than guessed. Only the laid-out height knows
   * whether a report fits, so the clamp is compared against what it hides and the
   * expander is drawn only while it is hiding something.
   */
  interface Props {
    projectId: string
    report: PrAgentReport
    /** True while a report is being posted as a pull request comment. */
    posting: boolean
    /** Reopen the thread this assignment runs in. */
    onOpenThread: (threadId: string) => void
    /** Show the conversation entry this assignment answered, in the reader. */
    onShowInConversation: (report: PrAgentReport) => void
    /** Post the finished report into the pull request conversation. */
    onPostReport: (report: PrAgentReport) => void
  }

  let { projectId, report, posting, onOpenThread, onShowInConversation, onPostReport }: Props =
    $props()

  let expanded = $state(false)
  /** True while the folded body is cutting the report short. */
  let clipped = $state(false)

  const written = $derived(report.updatedAt ?? report.createdAt)
  const hasBody = $derived(report.content.trim().length > 0)

  /**
   * A triage assignment answers the pull request rather than one comment, so it
   * carries no permalink and both controls that lead back to a comment are absent
   * for it. Both are read through a local so the narrowing survives into the click
   * handlers.
   */
  const commentUrl = $derived(report.url)
  const threadId = $derived(report.threadId)

  /**
   * Measure whether the fold is cutting the report short.
   *
   * Only the laid-out height knows whether a report fits, so the clamp is
   * compared against what it hides. An attachment rather than an effect over a
   * `bind:this`, because the measurement belongs to the element and so does the
   * observer's lifetime. Reading `expanded` here is what re-measures on a fold,
   * and the observer covers the other two reasons the answer changes: a report
   * that grows past five lines, and a narrower rail that re-wraps it taller.
   */
  const measureFold: Attachment<HTMLDivElement> = (element) => {
    const measure = (): void => {
      clipped = !expanded && element.scrollHeight > element.clientHeight + 1
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }

  const actionClass =
    'flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-1.5 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground'

  /** The same control for one that is only an icon, so it stays square. */
  const iconActionClass =
    'flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-elevated hover:text-foreground'

  function openReportFile(): void {
    void revealCitationFile(projectId, report.path)
  }
</script>

<article class="overflow-hidden rounded-lg border border-border bg-surface">
  <!--
    Two rows, because the card answers two questions: what this assignment was,
    and where its answer can be read. The first row names it and offers the one
    thing that leads back to what it was asked, the second carries when it was
    written and the three places its output lives. The permalink is the only
    control that leaves the app, so it is the only icon-only one, and it declares
    its address for the app's link context menu to find.
  -->
  <header class="border-b border-border/60 bg-elevated/50 px-2.5 py-1.5">
    <div class="flex items-center gap-1.5">
      <Bot size={13} class="shrink-0 {hasBody ? 'text-primary' : 'text-dimmed'}" />
      <p
        class="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-foreground"
        title={report.title}
      >
        {report.title}
      </p>
      {#if commentUrl}
        <button
          type="button"
          class={actionClass}
          title="Show the comment this assignment answered in the conversation"
          onclick={() => onShowInConversation(report)}
        >
          <MessageSquare size={11} class="shrink-0" />
          Show comment
        </button>
      {/if}
    </div>
    <div class="mt-1 flex items-center gap-1">
      {#if written}
        <p class="min-w-0 truncate text-[0.5625rem] text-dimmed">
          {report.updatedAt ? 'Written' : 'Assigned'}
          {relativeTime(written)}
        </p>
      {/if}
      <div class="ml-auto flex shrink-0 items-center gap-1">
        {#if threadId}
          <button
            type="button"
            class={actionClass}
            title="Open the agent thread this assignment runs in"
            onclick={() => onOpenThread(threadId)}
          >
            <MessagesSquare size={11} class="shrink-0" />
            Thread
          </button>
        {/if}
        <button
          type="button"
          class={actionClass}
          title="Open the report file in the file tree"
          onclick={openReportFile}
        >
          <FileText size={11} class="shrink-0" />
          Report
        </button>
        {#if commentUrl}
          <button
            type="button"
            class={iconActionClass}
            data-external-url={commentUrl}
            title="Open the comment this assignment answered on GitHub"
            aria-label="Open the comment this assignment answered on GitHub"
            onclick={() => void openInBrowser(commentUrl)}
          >
            <ExternalLink size={11} />
          </button>
        {/if}
      </div>
    </div>
  </header>

  {#if hasBody}
    <div class="px-2.5 py-2">
      <div class:agent-report-folded={!expanded} {@attach measureFold}>
        <MarkdownView text={report.content} />
      </div>
    </div>
    <footer
      class="flex items-center gap-2 border-t border-border/60 px-2.5 py-1 {clipped || expanded
        ? 'justify-between'
        : 'justify-end'}"
    >
      {#if clipped || expanded}
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-expanded={expanded}
          title={expanded ? 'Fold this report to five lines' : 'Show the whole report'}
          onclick={() => (expanded = !expanded)}
        >
          <ChevronDown
            size={12}
            class="shrink-0 transition-transform {expanded ? 'rotate-180' : ''}"
          />
          {expanded ? 'Show less' : 'Show more'}
        </button>
      {/if}
      <button
        type="button"
        class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
        title="Post this report as a comment on the pull request"
        disabled={posting}
        onclick={() => onPostReport(report)}
      >
        <Send size={12} />
        Post to PR
      </button>
    </footer>
  {:else}
    <p class="px-2.5 py-2 text-[0.6875rem] leading-relaxed text-dimmed">
      This assignment has not written its report yet. It lands in the report file when the agent
      finishes, and the thread is where you can watch it work.
    </p>
  {/if}
</article>

<style>
  /*
   * Five lines of the conversation reading step, which is the step the report
   * below is set in. The numbers are the prose surface's own (`--prose-*` in
   * app.css), so a change to how prose reads moves this clamp with it.
   */
  .agent-report-folded {
    max-height: calc(5 * var(--prose-leading) * var(--prose-size));
    overflow: hidden;
  }
</style>
