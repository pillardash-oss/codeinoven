<script lang="ts">
  import { Check, Clock, ListChecks, Loader2, Plug } from '@lucide/svelte'
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
    existingConnections = [],
    saving,
    onSave,
    onKeepEditing
  }: Props = $props()

  // A routine that is already saved keeps everything the revision does not name,
  // so a plan that omits the schedule or the connections is not an empty one.
  const scheduleLabel = $derived(
    plan?.schedule
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
</script>

<div
  class="rounded-xl border border-primary/30 bg-primary/5 px-4 py-3"
  role="group"
  aria-label="Review the routine the agent drafted"
>
  <div class="flex items-start gap-3">
    <span
      class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
    >
      <ListChecks size={15} strokeWidth={1.8} />
    </span>
    <div class="min-w-0 flex-1">
      <p class="text-[0.8125rem] font-semibold text-foreground">
        {update ? 'Ready to update' : 'Ready to save'}
        <span class="text-muted">{routineName}</span>
      </p>
      <p class="mt-0.5 text-[0.75rem] leading-relaxed text-muted">
        {#if update}
          The agent revised this routine. Check the recap, then save the change when you are happy.
          Everything it does not name stays as it is.
        {:else}
          The agent drafted this routine. Check the recap, then save it when you are happy.
        {/if}
      </p>

      <dl class="mt-2 flex flex-col gap-1 text-[0.75rem]">
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

      <div class="mt-3 flex items-center gap-2">
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          title={update
            ? "Save the routine's revised instructions, schedule, and connections"
            : "Save the routine's instructions, schedule, and connections"}
          aria-label={update ? 'Update the routine' : 'Save the routine'}
          disabled={saving}
          onclick={onSave}
        >
          {#if saving}
            <Loader2 size={12} strokeWidth={1.8} class="animate-spin" />
            Saving
          {:else}
            <Check size={12} strokeWidth={2} />
            {update ? 'Save changes' : 'Save routine'}
          {/if}
        </button>
        <button
          type="button"
          class="shrink-0 rounded-md px-2 py-1.5 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
          title="Keep working on the routine with the agent"
          aria-label="Keep editing the routine"
          disabled={saving}
          onclick={onKeepEditing}
        >
          Keep editing
        </button>
      </div>
    </div>
  </div>
</div>
