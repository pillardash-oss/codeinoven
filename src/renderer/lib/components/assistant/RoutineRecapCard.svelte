<script lang="ts">
  import { Check, Clock, ListChecks, Plug } from '@lucide/svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import { foldSlide } from '../shared/card-motion'
  import { describeSchedule } from '$shared/types'
  import { parseHowToSections, type RoutinePlanDraft } from './assistant-view'

  /**
   * The routine recap the authoring agent asks the user to confirm.
   *
   * The agent drafts the how-to, the schedule, and the connections in the
   * conversation and asks whether the user is happy with them. This card turns
   * that draft into the go-ahead: it shows exactly what will be saved and
   * commits it on one click, so the user never has to remember a slash command.
   * `/save-how-to` stays only as a fallback for when this path cannot run.
   *
   * The same card serves a revision: a routine that is already saved keeps its
   * Getting started thread, and the agent presents the revised how-to there when
   * the user asks for a change. `update` says which of the two it is, so the card
   * never offers to "save the routine" the user already has.
   */
  interface Props {
    routineName: string
    howTo: string
    plan: RoutinePlanDraft | null
    /** True when this recap revises a routine that is already saved. */
    update?: boolean
    /**
     * Whether this routine runs on a schedule. An on-demand routine has no
     * schedule to agree, so the card says so instead of asking for one.
     */
    scheduled?: boolean
    /**
     * The connection labels the routine already has. A revision keeps the ones
     * its plan does not name, so the recap lists them too instead of reading as
     * if they were being dropped.
     */
    existingConnections?: string[]
    saving: boolean
    onSave: () => void
    onKeepEditing: () => void
  }

  let {
    routineName,
    howTo,
    plan,
    update = false,
    scheduled = true,
    existingConnections = [],
    saving,
    onSave,
    onKeepEditing
  }: Props = $props()

  let folded = $state(false)

  // A routine that is already saved keeps everything the revision does not name,
  // so a plan that omits the schedule or the connections is not an empty one.
  // An on-demand routine has no schedule at all, so it never reads as one left
  // unset.
  const scheduleLabel = $derived(
    !scheduled
      ? 'Runs on demand'
      : plan?.schedule
        ? describeSchedule(plan.schedule)
        : update
          ? 'Kept as saved'
          : 'No schedule agreed yet'
  )
  const sectionCount = $derived(parseHowToSections(howTo).length)
  /** The connections the routine has once this recap is saved. */
  const connectionNames = $derived(
    Array.from(
      new Set([
        ...(plan?.connections.map((connection) => connection.name) ?? []),
        ...(update ? existingConnections : [])
      ])
    )
  )

  const cardTitle = $derived(`${update ? 'Ready to update' : 'Ready to save'} ${routineName}`)

  const saveTitle = $derived(
    (update ? "Save the routine's revised " : "Save the routine's ") +
      (scheduled ? 'instructions, schedule, and connections' : 'instructions and connections')
  )
</script>

<CardFrame placement="replace" label="Review the routine the agent drafted">
  <CardHead
    icon={ListChecks}
    title={cardTitle}
    chip={{ text: 'Draft', tone: 'paused' }}
    bind:folded
    foldLabel="routine recap"
  />

  {#if !folded}
    <div
      transition:slide={foldSlide()}
      class="flex flex-col gap-2 px-3 py-2.5 text-xs leading-relaxed text-muted"
    >
      <p>
        {#if update}
          The agent revised this routine. Check the recap, then save the change when you are happy.
          Everything it does not name stays as it is.
        {:else}
          The agent drafted this routine. Check the recap, then save it when you are happy.
        {/if}
      </p>

      <dl class="flex flex-col gap-1">
        <div class="flex items-start gap-2">
          <dt class="flex shrink-0 items-center gap-1.5 text-dimmed" title="When the routine runs">
            <Clock size={12} strokeWidth={1.8} />
            <span>Schedule</span>
          </dt>
          <dd class="min-w-0 flex-1 text-foreground">{scheduleLabel}</dd>
        </div>
        <div class="flex items-start gap-2">
          <dt
            class="flex shrink-0 items-center gap-1.5 text-dimmed"
            title="Utilities the routine needs"
          >
            <Plug size={12} strokeWidth={1.8} />
            <span>Connections</span>
          </dt>
          <dd class="min-w-0 flex-1 text-foreground">
            {connectionNames.length > 0
              ? connectionNames.join(', ')
              : update
                ? 'Kept as saved'
                : 'None'}
          </dd>
        </div>
        <div class="flex items-start gap-2">
          <dt class="flex shrink-0 items-center gap-1.5 text-dimmed" title="The saved instructions">
            <Check size={12} strokeWidth={1.8} />
            <span>Instructions</span>
          </dt>
          <dd class="min-w-0 flex-1 text-foreground">
            {sectionCount} section{sectionCount === 1 ? '' : 's'}
          </dd>
        </div>
      </dl>
    </div>
  {/if}

  {#if !folded}
    <CardFoot>
      {#snippet left()}
        <CardButton
          label="Keep editing"
          title="Keep working on the routine with the agent"
          variant="ghost"
          disabled={saving}
          onclick={onKeepEditing}
        />
      {/snippet}
      {#snippet right()}
        <CardButton
          label={update ? 'Save changes' : 'Save routine'}
          title={saveTitle}
          icon={saving ? undefined : Check}
          variant="primary"
          loading={saving}
          disabled={saving}
          onclick={onSave}
        />
      {/snippet}
    </CardFoot>
  {/if}
</CardFrame>
