<script lang="ts">
  import { Check, Clock, ListChecks, Plug, Signature, Sparkles } from '@lucide/svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import { foldSlide } from '../shared/card-motion'
  import { describeSchedule } from '$shared/types'
  import { parseKnowledgeSections, type AssistantPlanDraft } from './assistant-view'

  /**
   * The assistant recap the authoring agent asks the user to confirm.
   *
   * The agent drafts the knowledge, the schedule, and the connections in the
   * conversation and asks whether the user is happy with them. This card turns
   * that draft into the go-ahead: it shows exactly what will be saved and
   * commits it on one click, so the user never has to remember a slash command.
   * `/save-knowledge` stays only as a fallback for when this path cannot run.
   *
   * The same card serves a revision: an assistant that is already saved keeps its
   * Getting started thread, and the agent presents the revised knowledge there when
   * the user asks for a change. `update` says which of the two it is, so the card
   * never offers to "save the assistant" the user already has.
   */
  interface Props {
    assistantName: string
    knowledge: string
    plan: AssistantPlanDraft | null
    /** True when this recap revises an assistant that is already saved. */
    update?: boolean
    /**
     * Whether this assistant runs on a schedule. An on-demand assistant has no
     * schedule to agree, so the card says so instead of asking for one.
     */
    scheduled?: boolean
    /**
     * The connection labels the assistant already has. A revision keeps the ones
     * its plan does not name, so the recap lists them too instead of reading as
     * if they were being dropped.
     */
    existingConnections?: string[]
    saving: boolean
    onSave: () => void
    onKeepEditing: () => void
  }

  let {
    assistantName,
    knowledge,
    plan,
    update = false,
    scheduled = true,
    existingConnections = [],
    saving,
    onSave,
    onKeepEditing
  }: Props = $props()

  let folded = $state(false)

  /**
   * Whether the assistant ends up on a clock. The conversation settles that as
   * well as the schedule itself, so a recap that turned the clock off says so
   * instead of showing the assistant's stored flag.
   */
  const keepsClock = $derived(plan?.scheduled ?? scheduled)

  // An assistant that is already saved keeps everything the revision does not name,
  // so a plan that omits the schedule or the connections is not an empty one.
  // An on-demand assistant has no schedule at all, so it never reads as one left
  // unset.
  const scheduleLabel = $derived.by(() => {
    if (!keepsClock) return 'Runs on demand'
    const cadence = plan?.schedule
      ? describeSchedule(plan.schedule)
      : update
        ? 'Kept as saved'
        : 'No schedule agreed yet'
    return plan?.scheduleName ? `${plan.scheduleName} · ${cadence}` : cadence
  })
  const sectionCount = $derived(parseKnowledgeSections(knowledge).length)
  /** The connections the assistant has once this recap is saved. */
  const connectionNames = $derived(
    Array.from(
      new Set([
        ...(plan?.connections.map((connection) => connection.name) ?? []),
        ...(update ? existingConnections : [])
      ])
    )
  )

  const cardTitle = $derived(
    `${update ? 'Ready to update' : 'Ready to save'} ${plan?.name ?? assistantName}`
  )

  const saveTitle = $derived(
    (update ? "Save the assistant's revised " : "Save the assistant's ") +
      (keepsClock ? 'instructions, schedule, and connections' : 'instructions and connections')
  )
</script>

<CardFrame placement="replace" label="Review the assistant the agent drafted">
  <CardHead
    icon={ListChecks}
    title={cardTitle}
    chip={{ text: 'Draft', tone: 'paused' }}
    bind:folded
    foldLabel="assistant recap"
  />

  {#if !folded}
    <div
      transition:slide={foldSlide()}
      class="flex flex-col gap-2 px-3 py-2.5 text-xs leading-relaxed text-muted"
    >
      <p>
        {#if update}
          The agent revised this assistant. Check the recap, then save the change when you are
          happy. Everything it does not name stays as it is.
        {:else}
          The agent drafted this assistant. Check the recap, then save it when you are happy.
        {/if}
      </p>

      <dl class="flex flex-col gap-1">
        {#if plan?.name}
          <div class="flex items-start gap-2">
            <dt class="flex shrink-0 items-center gap-1.5 text-dimmed" title="The name you gave it">
              <Signature size={12} strokeWidth={1.8} />
              <span>Name</span>
            </dt>
            <dd class="min-w-0 flex-1 text-foreground">{plan.name}</dd>
          </div>
        {/if}
        {#if plan?.personality}
          <div class="flex items-start gap-2">
            <dt
              class="flex shrink-0 items-center gap-1.5 text-dimmed"
              title="How it behaves and sounds"
            >
              <Sparkles size={12} strokeWidth={1.8} />
              <span>Personality</span>
            </dt>
            <dd class="min-w-0 flex-1 text-foreground">{plan.personality}</dd>
          </div>
        {/if}
        <div class="flex items-start gap-2">
          <dt
            class="flex shrink-0 items-center gap-1.5 text-dimmed"
            title="When the assistant runs"
          >
            <Clock size={12} strokeWidth={1.8} />
            <span>Schedule</span>
          </dt>
          <dd class="min-w-0 flex-1 text-foreground">{scheduleLabel}</dd>
        </div>
        <div class="flex items-start gap-2">
          <dt
            class="flex shrink-0 items-center gap-1.5 text-dimmed"
            title="Utilities the assistant needs"
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
          title="Keep working on the assistant with the agent"
          variant="ghost"
          disabled={saving}
          onclick={onKeepEditing}
        />
      {/snippet}
      {#snippet right()}
        <CardButton
          label={update ? 'Save changes' : 'Save assistant'}
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
