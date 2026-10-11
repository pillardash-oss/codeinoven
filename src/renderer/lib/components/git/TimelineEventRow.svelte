<script lang="ts">
  import { relativeTime } from '$lib/format/relative-time'
  import { githubDisplayLogin } from '$lib/format/github-login'
  import { openInBrowser } from '$lib/open-in-browser'
  import BotBadge from './BotBadge.svelte'
  import TimelineRailItem from './TimelineRailItem.svelte'
  import { issueReferenceLabel, type IssueTimelineLine } from './issue-view'
  import { timelineEventIcon, timelineEventToneClass } from './timeline-view'
  import { prLabelStyle } from './pr-view'
  import type { IssueTimelineEvent } from '$shared/types'

  /**
   * One thing that happened, as the timeline draws it.
   *
   * The sentence is already built by `issueTimelineLine`, and the parts of it that
   * are things rather than words keep their own control: a label keeps its chip and
   * colour, a cross-reference stays a link, and a commit opens in the Git panel.
   */
  interface Props {
    event: IssueTimelineEvent
    line: IssueTimelineLine
    /**
     * `owner/repo` of the repository being read, so a reference that lives in
     * another repository is labelled with the one it lives in.
     */
    repository: string
    first?: boolean
    last?: boolean
    /** Open a commit this event named, in the Git panel. */
    onOpenCommit: (commitId: string) => void
  }

  let { event, line, repository, first = false, last = false, onOpenCommit }: Props = $props()

  const Icon = $derived(timelineEventIcon(event))
  const toneClass = $derived(timelineEventToneClass(event))
</script>

<TimelineRailItem {first} {last}>
  {#snippet gutter()}
    <!--
      Decoration: the sentence beside it already says what happened, so it is kept
      out of the accessibility tree rather than announced as a second version of the
      same fact.
    -->
    <Icon size={13} class="shrink-0 {toneClass}" aria-hidden="true" />
  {/snippet}
  <p class="text-[0.625rem] leading-relaxed text-muted">
    <span class="font-medium text-foreground">{githubDisplayLogin(event.actorLogin)}</span>
    {#if event.actorIsBot}
      <BotBadge />
    {/if}
    <span> {line.lead}</span>
    {#if line.label}
      <span
        class="mx-1 inline-block max-w-[14ch] truncate rounded-full px-1.5 py-0.5 align-middle text-[0.5625rem] font-medium leading-none"
        style={prLabelStyle(line.label.color)}
      >
        {line.label.name}
      </span>
    {/if}
    {#if line.reference}
      {@const reference = line.reference}
      <button
        type="button"
        class="mx-1 cursor-pointer text-[0.625rem] font-medium text-primary hover:underline"
        title={`Open ${issueReferenceLabel(reference, repository)} on GitHub`}
        onclick={() => void openInBrowser(reference.url)}
      >
        {issueReferenceLabel(reference, repository)}
      </button>
    {/if}
    {#if line.commitId}
      {@const commitId = line.commitId}
      <!--
        The commit is in this repository, so it opens where the repository is read
        rather than on github.com.
      -->
      <button
        type="button"
        class="mx-1 cursor-pointer font-mono text-[0.625rem] font-medium text-primary hover:underline"
        title={`Open commit ${commitId.slice(0, 7)} in the Git panel`}
        aria-label={`Open commit ${commitId.slice(0, 7)} in the Git panel`}
        onclick={() => onOpenCommit(commitId)}
      >
        {commitId.slice(0, 7)}
      </button>
    {/if}
    {#if line.trail}
      <span> {line.trail}</span>
    {/if}
    <span class="text-dimmed"> · {relativeTime(event.createdAt)}</span>
  </p>
</TimelineRailItem>
