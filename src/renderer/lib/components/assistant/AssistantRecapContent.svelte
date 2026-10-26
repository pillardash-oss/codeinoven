<script lang="ts">
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
  import type { Component } from 'svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import { assistantDeliveryLabel, assistantPriorityLabel } from '$shared/assistant-reporting'
  import { describeSchedule } from '$shared/types'
  import { parseKnowledgeSections, type AssistantPlanDraft } from './assistant-view'
  import { assistantKnowledgeLoss } from './assistant-recap'

  /**
   * What the recap card commits, stated the way a reader can check it.
   *
   * The authoring agent hands the app two fenced blocks: the instructions it
   * wrote, and a JSON plan the app acts on. Neither is something a person should
   * have to read, so this draws them as the two things they actually are: a short
   * ledger of the settings the save will write, and the instruction document
   * itself, section by section, as prose.
   *
   * It is one component because the same review appears twice: inside the card
   * above the composer, where it scrolls, and full screen, where it does not.
   */
  interface Props {
    knowledge: string
    plan: AssistantPlanDraft | null
    /** True when this recap revises an assistant that is already saved. */
    update?: boolean
    /**
     * The instructions saved right now, which a revision replaces. The draft
     * carries only the document that survives, so without these the card reads as
     * an ordinary save however much of the saved knowledge it drops.
     */
    previousKnowledge?: string
    /** Whether this assistant runs on a schedule. */
    scheduled?: boolean
    /** The connection labels the assistant already has, kept by a revision. */
    existingConnections?: string[]
  }

  let {
    knowledge,
    plan,
    update = false,
    previousKnowledge = '',
    scheduled = true,
    existingConnections = []
  }: Props = $props()

  /** Whether the assistant ends up on a clock, settled by the plan when it says. */
  const keepsClock = $derived(plan?.scheduled ?? scheduled)

  // An assistant that is already saved keeps everything the revision does not
  // name, so a plan that omits the schedule or the connections is not an empty
  // one. An on-demand assistant has no schedule at all, so it never reads as one
  // left unset.
  const scheduleLabel = $derived.by(() => {
    if (!keepsClock) return 'Runs only when you ask'
    const cadence = plan?.schedule
      ? describeSchedule(plan.schedule)
      : update
        ? 'Kept as saved'
        : 'No schedule agreed yet'
    return plan?.scheduleName ? `${plan.scheduleName} · ${cadence}` : cadence
  })

  /** The connections the assistant has once this recap is saved. */
  const connectionNames = $derived(
    Array.from(
      new Set([
        ...(plan?.connections.map((connection) => connection.name) ?? []),
        ...(update ? existingConnections : [])
      ])
    )
  )

  /** How it reports back, in the app's own labels. Empty for an action-only one. */
  const reportLabel = $derived.by(() => {
    const parts: string[] = []
    if (plan?.delivery) parts.push(assistantDeliveryLabel(plan.delivery))
    if (plan?.priority) parts.push(assistantPriorityLabel(plan.priority))
    return parts.join(' · ')
  })

  const sections = $derived(parseKnowledgeSections(knowledge))

  /** What this save would delete from the instructions it replaces, if anything. */
  const loss = $derived(assistantKnowledgeLoss(previousKnowledge, knowledge))

  interface RecapRow {
    icon: Component
    label: string
    /** What the value means, for the label's tooltip. */
    title: string
    value: string
  }

  const rows = $derived.by((): RecapRow[] => {
    const entries: RecapRow[] = []
    if (plan?.name) {
      entries.push({
        icon: CioPencil,
        label: 'Name',
        title: 'The name you gave it',
        value: plan.name
      })
    }
    if (plan?.personality) {
      entries.push({
        icon: CioSparkles,
        label: 'Personality',
        title: 'How it behaves and sounds',
        value: plan.personality
      })
    }
    entries.push({
      icon: CioClock,
      label: 'Schedule',
      title: 'When the assistant runs',
      value: scheduleLabel
    })
    entries.push({
      icon: CioPlug,
      label: 'Connections',
      title: 'The utilities the assistant needs',
      value:
        connectionNames.length > 0 ? connectionNames.join(', ') : update ? 'Kept as saved' : 'None'
    })
    if (reportLabel) {
      entries.push({
        icon: CioMessage,
        label: 'Reports',
        title: 'Where its output goes and how urgent it is',
        value: reportLabel
      })
    }
    return entries
  })
</script>

<div class="flex flex-col gap-2.5">
  <!-- The settings the save writes, one row each: a reader checks a ledger faster
       than a paragraph, and every value here is what the assistant will actually
       run with. -->
  <dl class="border border-border">
    {#each rows as row (row.label)}
      {@const Icon = row.icon}
      <div
        class="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0"
        data-recap-row={row.label.toLowerCase()}
      >
        <dt
          class="flex w-28 shrink-0 items-center gap-1.5 pt-0.5 text-[0.6875rem] text-dimmed"
          title={row.title}
        >
          <Icon size={12} strokeWidth={1.8} class="shrink-0" />
          <span class="truncate">{row.label}</span>
        </dt>
        <dd class="min-w-0 flex-1 text-[0.75rem] leading-relaxed break-words text-foreground">
          {row.value}
        </dd>
      </div>
    {/each}
  </dl>

  <!-- The instructions themselves: the document the assistant follows on every
       run, numbered so the reader can point at a section when they ask for a
       change instead of describing the whole thing again. -->
  <section class="border border-border" aria-label="The instructions the assistant will follow">
    <header
      class="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5"
      title="The instructions this assistant follows on every run"
    >
      <p class="text-[0.6875rem] font-semibold text-foreground">Instructions</p>
      <span class="text-[0.625rem] text-dimmed">
        {sections.length}
        {sections.length === 1 ? 'section' : 'sections'}
      </span>
    </header>
    <!-- A revision that throws most of the saved document away reads exactly like a
         small one until someone counts the lines, so the count is stated here where
         the decision is made, not in the log afterwards. -->
    {#if loss}
      <p
        class="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[0.6875rem] leading-relaxed text-danger"
        role="note"
      >
        Removes {loss.removed.length} of the {loss.previousLines} saved lines. Saving replaces these instructions
        instead of merging with them.
      </p>
    {/if}
    <ol class="flex flex-col">
      {#each sections as section, index (section.id)}
        <li class="border-b border-border px-3 py-2 last:border-b-0">
          <div class="flex items-baseline gap-2">
            <span class="w-4 shrink-0 text-right text-[0.5625rem] tabular-nums text-dimmed">
              {index + 1}
            </span>
            <p class="min-w-0 flex-1 text-[0.75rem] font-medium text-foreground">
              {section.title}
            </p>
          </div>
          {#if section.body}
            <div class="mt-1 pl-6 text-[0.75rem] leading-relaxed text-muted">
              <MarkdownView text={section.body} />
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  </section>
</div>
