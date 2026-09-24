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
   */
  interface Props {
    routineName: string
    howTo: string
    plan: RoutinePlanDraft | null
    saving: boolean
    onSave: () => void
    onKeepEditing: () => void
  }

  let { routineName, howTo, plan, saving, onSave, onKeepEditing }: Props = $props()

  const scheduleLabel = $derived(
    plan?.schedule ? describeSchedule(plan.schedule) : 'No schedule agreed yet'
  )
  const sectionCount = $derived(parseHowToSections(howTo).length)
  const connectionNames = $derived(plan?.connections.map((connection) => connection.name) ?? [])
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
        Ready to save <span class="text-muted">{routineName}</span>
      </p>
      <p class="mt-0.5 text-[0.75rem] leading-relaxed text-muted">
        The agent drafted this routine. Check the recap, then save it when you are happy.
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
            {connectionNames.length > 0 ? connectionNames.join(', ') : 'None'}
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
          title="Save the routine's instructions, schedule, and connections"
          aria-label="Save the routine"
          disabled={saving}
          onclick={onSave}
        >
          {#if saving}
            <Loader2 size={12} strokeWidth={1.8} class="animate-spin" />
            Saving
          {:else}
            <Check size={12} strokeWidth={2} />
            Save routine
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
