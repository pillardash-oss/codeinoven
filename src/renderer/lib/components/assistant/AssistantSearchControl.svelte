<script lang="ts">
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import { Popover } from 'bits-ui'
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import { assistants as assistantStore } from '$lib/stores/assistants.svelte'
  import { assistantIsScheduled, type Assistant, type Thread } from '$shared/types'
  import { assistantGap } from './assistant-view'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    assistants: Assistant[]
    /** Assistant tasks. */
    tasks: Thread[]
    /** One run per execution of a task, each its own thread. */
    runs: Thread[]
    /** Open a task or run result. */
    onOpenTask: (task: Thread) => void
    /** Open an assistant result (its knowledge panel / first task). */
    onOpenAssistant: (assistant: Assistant) => void
  }

  let { assistants, tasks, runs, onOpenTask, onOpenAssistant }: Props = $props()

  let open = $state(false)
  let query = $state('')
  let inputEl: HTMLInputElement | undefined = $state(undefined)

  const focusInput: Attachment<HTMLInputElement> = (element) => {
    inputEl = element
    element.focus()
  }

  const trimmed = $derived(query.trim().toLowerCase())

  const assistantResults = $derived(
    trimmed.length === 0
      ? []
      : assistants.filter((assistant) => assistant.name.toLowerCase().includes(trimmed))
  )
  const taskResults = $derived(
    trimmed.length === 0 ? [] : tasks.filter((task) => task.title.toLowerCase().includes(trimmed))
  )
  const runResults = $derived(
    trimmed.length === 0 ? [] : runs.filter((run) => run.title.toLowerCase().includes(trimmed))
  )
  const empty = $derived(
    trimmed.length > 0 &&
      assistantResults.length === 0 &&
      taskResults.length === 0 &&
      runResults.length === 0
  )

  function selectTask(task: Thread): void {
    onOpenTask(task)
    open = false
    query = ''
  }

  function selectAssistant(assistant: Assistant): void {
    onOpenAssistant(assistant)
    open = false
    query = ''
  }

  /** The assistant's own icon, so an assistant edited in the sidebar reads the same
   *  in the search results: custom image first, then the SVG icon type tinted
   *  with its accent colour. Without either the result draws the assistant
   *  default mark. */
  function assistantIcon(assistant: Assistant): string | null {
    return getAssistantIcon(assistant, assistantStore.iconUrls.get(assistant.id) ?? null)
  }

  function runAssistant(run: Thread): Assistant | null {
    return assistantStore.assistantForTask(run)
  }

  function runIcon(run: Thread): string | null {
    const assistant = runAssistant(run)
    if (!assistant) return null
    return assistantIcon(assistant)
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
    aria-label="Search assistants, tasks and runs"
    title="Search assistants, tasks and runs"
  >
    <CioSearch size={15} strokeWidth={1.8} />
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="bottom"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      class="z-50 w-80 overflow-hidden border bg-surface p-1.5 shadow-lg"
      aria-label="Search assistants, tasks and runs"
    >
      <div class="flex items-center gap-1.5">
        <CioSearch size={14} class="shrink-0 text-dimmed" />
        <input
          {@attach focusInput}
          type="text"
          class="h-7 min-w-0 flex-1 bg-app px-2 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search assistants, tasks and runs…"
          bind:value={query}
        />
        {#if query}
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Clear search"
            title="Clear search"
            onclick={() => {
              query = ''
              inputEl?.focus()
            }}
          >
            <CioClose size={13} />
          </button>
        {/if}
      </div>

      {#if empty}
        <p class="px-2 py-4 text-center text-[0.6875rem] text-dimmed">
          No matching assistants, tasks or runs
        </p>
      {:else if trimmed.length > 0}
        <div class="mt-1 max-h-80 overflow-y-auto overscroll-contain">
          {#if assistantResults.length > 0}
            <div
              class="border-b border-border px-2 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
            >
              Assistants
            </div>
            {#each assistantResults as assistant (assistant.id)}
              {@const icon = assistantIcon(assistant)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                onclick={() => selectAssistant(assistant)}
              >
                <span class="flex h-4 w-4 shrink-0 items-center justify-center">
                  {#if icon}
                    <img src={icon} alt="" class="h-4 w-4 object-contain" draggable="false" />
                  {:else}
                    <AssistantDefaultIcon
                      size={14}
                      style="color: {assistant.color ?? 'var(--color-muted)'}"
                    />
                  {/if}
                </span>
                <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground"
                  >{assistant.name}</span
                >
                {#if !assistantIsScheduled(assistant)}
                  <span
                    class="shrink-0 border border-border bg-elevated px-1.5 py-px text-[0.5rem] tracking-wide text-dimmed uppercase"
                    title="This assistant runs only when you ask it to"
                  >
                    Unscheduled
                  </span>
                {/if}
                {#if assistantGap(assistant)}
                  <span
                    class="flex shrink-0 items-center"
                    style="color: var(--color-warning)"
                    role="img"
                    aria-label={assistantGap(assistant) ?? ''}
                    title={assistantGap(assistant) ?? ''}
                  >
                    <CioAttention size={11} />
                  </span>
                {/if}
              </button>
            {/each}
          {/if}
          {#if taskResults.length > 0}
            <div
              class="border-b border-border px-2 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
            >
              Tasks
            </div>
            {#each taskResults as task (task.id)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                onclick={() => selectTask(task)}
              >
                <AssistantIcon
                  mark={task.assistantGettingStarted ? 'knowledge' : 'task'}
                  size={14}
                  class="shrink-0 text-muted"
                />
                <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground"
                  >{task.title}</span
                >
              </button>
            {/each}
          {/if}
          {#if runResults.length > 0}
            <div
              class="border-b border-border px-2 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
            >
              Runs
            </div>
            {#each runResults as run (run.id)}
              {@const assistant = runAssistant(run)}
              {@const icon = runIcon(run)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                onclick={() => selectTask(run)}
              >
                <span class="flex h-4 w-4 shrink-0 items-center justify-center">
                  {#if icon}
                    <img src={icon} alt="" class="h-4 w-4 object-contain" draggable="false" />
                  {:else if assistant}
                    <AssistantDefaultIcon
                      size={14}
                      style="color: {assistant.color ?? 'var(--color-muted)'}"
                    />
                  {:else}
                    <AssistantIcon mark="task" size={14} class="text-muted" />
                  {/if}
                </span>
                <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground"
                  >{run.title}</span
                >
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
