<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { CADENCE_LABELS, SCHEDULE_CADENCES, type RoutineSchedule, type ScheduleCadence } from '$shared/types'

  interface Props {
    value: RoutineSchedule | null
    onChange: (schedule: RoutineSchedule | null) => void
    /** Show a "use the routine schedule" reset when the value can be inherited. */
    inheritLabel?: string
    onInherit?: () => void
    disabled?: boolean
  }

  let { value, onChange, inheritLabel, onInherit, disabled = false }: Props = $props()

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

  const cadence: ScheduleCadence = $derived(value?.cadence ?? 'daily')
  const timesText = $derived((value?.times ?? []).join(', '))
  const selectedWeekdays = $derived(new SvelteSet(value?.weekdays ?? []))

  function emit(next: Partial<RoutineSchedule>): void {
    onChange({
      cadence: next.cadence ?? cadence,
      times: next.times ?? value?.times ?? [],
      ...(next.weekdays !== undefined ? { weekdays: next.weekdays } : {}),
      ...(next.onceAt !== undefined ? { onceAt: next.onceAt } : {})
    })
  }

  function changeCadence(next: ScheduleCadence): void {
    if (next === 'once') {
      emit({ cadence: 'once', onceAt: value?.onceAt ?? Date.now() + 60 * 60 * 1000 })
      return
    }
    emit({ cadence: next })
  }

  function changeTimes(raw: string): void {
    const times = raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => /^\d{1,2}:\d{2}$/.test(part))
    emit({ times })
  }

  function toggleWeekday(day: number): void {
    const next = new SvelteSet(selectedWeekdays)
    if (next.has(day)) next.delete(day)
    else next.add(day)
    emit({ weekdays: [...next].sort((a, b) => a - b) })
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex items-center gap-2">
    <label class="text-[0.6875rem] text-muted" for="assistant-schedule-cadence">Repeats</label>
    <select
      id="assistant-schedule-cadence"
      class="rounded-md border border-border bg-surface px-2 py-1 text-[0.75rem] text-foreground focus:border-border-strong focus:outline-none disabled:opacity-50"
      value={cadence}
      {disabled}
      onchange={(event) => changeCadence(event.currentTarget.value as ScheduleCadence)}
    >
      {#each SCHEDULE_CADENCES as option (option)}
        <option value={option}>{CADENCE_LABELS[option]}</option>
      {/each}
    </select>
    {#if onInherit && inheritLabel}
      <button
        type="button"
        class="ml-auto text-[0.625rem] text-muted underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
        {disabled}
        onclick={onInherit}
      >
        {inheritLabel}
      </button>
    {/if}
  </div>

  {#if cadence === 'once'}
    <label class="flex flex-col gap-1 text-[0.6875rem] text-muted">
      <span>Run at</span>
      <input
        type="datetime-local"
        class="rounded-md border border-border bg-surface px-2 py-1 text-[0.75rem] text-foreground focus:border-border-strong focus:outline-none disabled:opacity-50"
        {disabled}
        value={value?.onceAt ? new Date(value.onceAt).toISOString().slice(0, 16) : ''}
        onchange={(event) =>
          emit({ onceAt: new Date(event.currentTarget.value).getTime(), cadence: 'once' })}
      />
    </label>
  {:else if cadence === 'hourly'}
    <p class="text-[0.625rem] text-dimmed">Runs at the top of every hour.</p>
  {:else}
    <label class="flex flex-col gap-1 text-[0.6875rem] text-muted">
      <span>Times of day (24h, comma separated)</span>
      <input
        class="rounded-md border border-border bg-surface px-2 py-1 text-[0.75rem] text-foreground focus:border-border-strong focus:outline-none disabled:opacity-50"
        value={timesText}
        placeholder="09:00, 17:00"
        {disabled}
        onchange={(event) => changeTimes(event.currentTarget.value)}
      />
    </label>
    {#if cadence === 'weekly'}
      <div class="flex flex-wrap items-center gap-1">
        <span class="text-[0.6875rem] text-muted">Days</span>
        {#each WEEKDAYS as day, index (day)}
          <button
            type="button"
            class="rounded px-1.5 py-0.5 text-[0.625rem] transition-colors {selectedWeekdays.has(
              index
            )
              ? 'bg-elevated text-foreground'
              : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
            aria-pressed={selectedWeekdays.has(index)}
            aria-label="Toggle {day}"
            {disabled}
            onclick={() => toggleWeekday(index)}
          >
            {day}
          </button>
        {/each}
      </div>
    {/if}
  {/if}
</div>
