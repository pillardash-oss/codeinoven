<script lang="ts">
  import { AlertTriangle, Clock1, Hammer, Search, Workflow, X } from '@lucide/svelte'
  import { Popover } from 'bits-ui'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import type { Routine, Thread } from '$shared/types'
  import { routineGap } from './assistant-view'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    routines: Routine[]
    tasks: Thread[]
    /** Open a task result. */
    onOpenTask: (task: Thread) => void
    /** Open a routine result (its how-to panel / first task). */
    onOpenRoutine: (routine: Routine) => void
  }

  let { routines, tasks, onOpenTask, onOpenRoutine }: Props = $props()

  let open = $state(false)
  let query = $state('')
  let inputEl: HTMLInputElement | undefined = $state(undefined)

  const focusInput: Attachment<HTMLInputElement> = (element) => {
    inputEl = element
    element.focus()
  }

  const trimmed = $derived(query.trim().toLowerCase())

  const routineResults = $derived(
    trimmed.length === 0
      ? []
      : routines.filter((routine) => routine.name.toLowerCase().includes(trimmed))
  )
  const taskResults = $derived(
    trimmed.length === 0
      ? []
      : tasks.filter((task) => task.title.toLowerCase().includes(trimmed))
  )
  const empty = $derived(
    trimmed.length > 0 && routineResults.length === 0 && taskResults.length === 0
  )

  function selectTask(task: Thread): void {
    onOpenTask(task)
    open = false
    query = ''
  }

  function selectRoutine(routine: Routine): void {
    onOpenRoutine(routine)
    open = false
    query = ''
  }

  function routineIcon(routine: Routine): string | null {
    return routine.iconType
      ? getIconSvgDataUrl(routine.iconType, routine.color ?? '#8b95a5')
      : null
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
    aria-label="Search routines and tasks"
    title="Search routines and tasks"
  >
    <Search size={15} strokeWidth={1.8} />
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="bottom"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      class="z-50 w-80 overflow-hidden rounded-xl border bg-surface p-1.5 shadow-lg"
      aria-label="Search routines and tasks"
    >
      <div class="flex items-center gap-1.5">
        <Search size={14} class="shrink-0 text-dimmed" />
        <input
          {@attach focusInput}
          type="text"
          class="h-7 min-w-0 flex-1 rounded-lg bg-app px-2 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search routines and tasks…"
          bind:value={query}
        />
        {#if query}
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Clear search"
            title="Clear search"
            onclick={() => {
              query = ''
              inputEl?.focus()
            }}
          >
            <X size={13} />
          </button>
        {/if}
      </div>

      {#if empty}
        <p class="px-2 py-4 text-center text-[0.6875rem] text-dimmed">No matching routines or tasks</p>
      {:else if trimmed.length > 0}
        <div class="mt-1 max-h-80 overflow-y-auto overscroll-contain">
          {#if routineResults.length > 0}
            <div class="px-2 py-1 text-[0.5625rem] font-medium uppercase tracking-wide text-dimmed">
              Routines
            </div>
            {#each routineResults as routine (routine.id)}
              {@const icon = routineIcon(routine)}
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                onclick={() => selectRoutine(routine)}
              >
                <span class="flex h-4 w-4 shrink-0 items-center justify-center">
                  {#if icon}
                    <img src={icon} alt="" class="h-4 w-4 object-contain" draggable="false" />
                  {:else}
                    <Workflow size={14} style="color: {routine.color ?? 'var(--color-muted)'}" />
                  {/if}
                </span>
                <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground"
                  >{routine.name}</span
                >
                {#if routineGap(routine)}
                  <span
                    class="flex shrink-0 items-center"
                    style="color: var(--color-warning)"
                    role="img"
                    aria-label={routineGap(routine) ?? ''}
                    title={routineGap(routine) ?? ''}
                  >
                    <AlertTriangle size={11} />
                  </span>
                {/if}
              </button>
            {/each}
          {/if}
          {#if taskResults.length > 0}
            <div class="px-2 py-1 text-[0.5625rem] font-medium uppercase tracking-wide text-dimmed">
              Tasks
            </div>
            {#each taskResults as task (task.id)}
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                onclick={() => selectTask(task)}
              >
                {#if task.assistantGettingStarted}
                  <Hammer size={14} strokeWidth={1.8} class="shrink-0 text-muted" />
                {:else}
                  <Clock1 size={14} strokeWidth={1.8} class="shrink-0 text-muted" />
                {/if}
                <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">{task.title}</span>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
