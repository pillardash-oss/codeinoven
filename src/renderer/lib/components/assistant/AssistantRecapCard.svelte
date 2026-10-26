<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioListChecks from '@pdslng/cio-icon/CioListChecks.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import { slide } from 'svelte/transition'
  import Modal from '../ui/Modal.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardTag from '../shared/CardTag.svelte'
  import { foldSlide } from '../shared/card-motion'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import AssistantRecapContent from './AssistantRecapContent.svelte'
  import type { AssistantPlanDraft } from './assistant-view'

  /**
   * The assistant recap the authoring agent asks the user to confirm.
   *
   * The agent drafts the instructions, the schedule and the connections in the
   * conversation. This card is that draft, and the only place it is approved: it
   * states what will be saved, shows the instruction document itself, and commits
   * the whole thing on one click. The agent is not asked to run a confirmation
   * question beside it, so the user answers once, here.
   *
   * It reads like the Assignment card it sits beside: a summary of what the save
   * writes, the drafted document in a scrollable body, a full screen review for
   * reading it properly, and the go-ahead on the right.
   *
   * The same card serves a revision: an assistant that is already saved keeps its
   * Getting started thread, and the agent presents the revised instructions there
   * when the user asks for a change. `update` says which of the two it is, so the
   * card never offers to "save the assistant" the user already has.
   */
  interface Props {
    assistantName: string
    knowledge: string
    plan: AssistantPlanDraft | null
    /** True when this recap revises an assistant that is already saved. */
    update?: boolean
    /**
     * The instructions saved right now, which a revision replaces. The card uses
     * them to say what the save would delete, since the draft carries only the
     * document that survives and reads as an ordinary save either way.
     */
    previousKnowledge?: string
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
    /** Another card sits directly above this one, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** The surface below carries the join, so this card drops its bottom rule. */
    joinsBelow?: boolean
    /** Thread the card belongs to, so its fold state is remembered per thread. */
    threadId?: string
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
    onKeepEditing,
    stackedAbove = false,
    joinsBelow = false,
    threadId
  }: Props = $props()

  /** The fold control writes a per-thread preference, so the card stays folded or
   *  unfolded when the thread is reopened. */
  let localFolded = $state(false)
  const foldState = {
    get folded(): boolean {
      return threadId === undefined
        ? localFolded
        : threadCardFold.isFolded(threadId, 'assistant-recap')
    },
    set folded(value: boolean) {
      if (threadId === undefined) localFolded = value
      else threadCardFold.setFolded(threadId, 'assistant-recap', value)
    }
  }

  /** The full screen review. A draft is not saved from there: the panel reads the
   *  whole document, then the user closes it and signs off on the card, which
   *  keeps one place where the assistant is committed. */
  let reviewing = $state(false)

  const name = $derived(plan?.name ?? assistantName)

  const cardTitle = $derived(`${update ? 'Ready to update' : 'Ready to save'} ${name}`)

  const intro = $derived(
    update
      ? 'The agent revised this assistant. Check what changes below, then save it. Everything it does not name stays as it is.'
      : 'The agent drafted this assistant. Check what will be saved below, then save it when you are happy.'
  )

  const saveTitle = $derived(
    (update ? "Save the assistant's revised " : "Save the assistant's ") +
      (plan?.scheduled ?? scheduled
        ? 'instructions, schedule, and connections'
        : 'instructions and connections')
  )
</script>

<CardFrame
  placement="replace"
  label="Review the assistant the agent drafted"
  {stackedAbove}
  {joinsBelow}
>
  <CardHead
    icon={CioListChecks}
    title={cardTitle}
    bind:folded={foldState.folded}
    foldLabel="assistant recap"
  >
    {#snippet meta()}
      <!-- A stamp, not a reading: this card holds a draft, and nothing about it
           is on a clock, so it carries no timer. -->
      <CardTag text="Draft" />
    {/snippet}
  </CardHead>

  {#if !foldState.folded}
    <div transition:slide={foldSlide()}>
      <p class="border-b border-border px-3 py-2.5 text-xs leading-relaxed text-muted">
        {intro}
      </p>

      <div
        id="assistant-recap-{threadId ?? 'draft'}"
        class="max-h-[32rem] overflow-y-auto px-3 py-2.5"
      >
        <AssistantRecapContent
          {knowledge}
          {plan}
          {update}
          {previousKnowledge}
          {scheduled}
          {existingConnections}
        />
      </div>

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
            label="Full screen"
            title="Read the whole recap full screen"
            icon={CioMaximize}
            variant="secondary"
            disabled={saving}
            onclick={() => (reviewing = true)}
          />
          <CardButton
            label={update ? 'Save changes' : 'Save assistant'}
            title={saveTitle}
            icon={saving ? undefined : CioCheck}
            variant="primary"
            loading={saving}
            disabled={saving}
            onclick={onSave}
          />
        {/snippet}
      </CardFoot>
    </div>
  {/if}
</CardFrame>

<Modal
  open={reviewing}
  title={cardTitle}
  description="The assistant the agent drafted, in full, before it is saved."
  placement="fullscreen"
  panelClass="bg-app"
  contentClass="overflow-y-auto px-6 py-4"
  onClose={() => (reviewing = false)}
>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-3">
    <p class="text-xs leading-relaxed text-muted">{intro}</p>
    <AssistantRecapContent
      {knowledge}
      {plan}
      {update}
      {previousKnowledge}
      {scheduled}
      {existingConnections}
    />
  </div>
  {#snippet footer()}
    <div class="mr-auto">
      <CardButton
        label="Close"
        title="Close the full screen recap"
        variant="ghost"
        onclick={() => (reviewing = false)}
      />
    </div>
    <CardButton
      label={update ? 'Save changes' : 'Save assistant'}
      title={saveTitle}
      icon={saving ? undefined : CioCheck}
      variant="primary"
      loading={saving}
      disabled={saving}
      onclick={() => {
        reviewing = false
        onSave()
      }}
    />
  {/snippet}
</Modal>
