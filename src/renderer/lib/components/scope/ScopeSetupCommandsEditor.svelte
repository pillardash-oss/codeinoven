<script lang="ts">
  import { ChevronDown, ChevronUp, Plus, Trash2 } from '@lucide/svelte'
  import type { ScopeSetupCommandSpec } from '$shared/types'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    commands: ScopeSetupCommandSpec[]
    onchange?: (commands: ScopeSetupCommandSpec[]) => void
  }

  let { commands = $bindable(), onchange }: Props = $props()

  const componentId = $props.id()
  let pendingExecutable = $state('')
  let pendingArgs = $state('')
  let removalIndex = $state<number | null>(null)

  function sanitizedArgs(value: string): string[] {
    return value
      .split(/\s+/u)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  function commit(nextCommands: ScopeSetupCommandSpec[]): void {
    commands = nextCommands
    onchange?.(nextCommands)
  }

  function addCommand(): void {
    const executable = pendingExecutable.trim()
    if (!executable) return
    commit([...commands, { executable, args: sanitizedArgs(pendingArgs) }])
    pendingExecutable = ''
    pendingArgs = ''
  }

  function updateCommand(index: number, update: Partial<ScopeSetupCommandSpec>): void {
    const command = commands[index]
    if (!command) return
    Object.assign(command, update)
    onchange?.(commands)
  }

  function moveCommand(index: number, direction: -1 | 1): void {
    const target = index + direction
    if (target < 0 || target >= commands.length) return
    const reordered = [...commands]
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    commit(reordered)
  }

  function removeCommand(): void {
    if (removalIndex === null) return
    commit(commands.filter((_, index) => index !== removalIndex))
    removalIndex = null
  }
</script>

<div class="space-y-2">
  <div class="flex items-center justify-between gap-3">
    <p class="text-xs font-medium text-muted">Setup commands</p>
    {#if commands.length > 0}
      <span class="text-xs tabular-nums text-dimmed">
        {commands.length} command{commands.length === 1 ? '' : 's'}
      </span>
    {/if}
  </div>

  {#if commands.length > 0}
    <ol class="space-y-1.5">
      {#each commands as command, index (command)}
        <li class="flex items-center gap-2 rounded-lg border bg-elevated px-2 py-2">
          <span class="w-5 shrink-0 text-right text-xs tabular-nums text-dimmed">{index + 1}</span>
          <div class="grid min-w-0 flex-1 grid-cols-[minmax(7rem,0.7fr)_minmax(9rem,1.3fr)] gap-2">
            <label class="sr-only" for={`${componentId}-command-${index}-executable`}>
              Command {index + 1} executable
            </label>
            <input
              id={`${componentId}-command-${index}-executable`}
              class="min-w-0 rounded-md border bg-surface px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
              value={command.executable}
              placeholder="Executable"
              oninput={(event) => updateCommand(index, { executable: event.currentTarget.value })}
            />
            <label class="sr-only" for={`${componentId}-command-${index}-args`}>
              Command {index + 1} arguments
            </label>
            <input
              id={`${componentId}-command-${index}-args`}
              class="min-w-0 rounded-md border bg-surface px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary"
              value={command.args.join(' ')}
              placeholder="Arguments"
              oninput={(event) =>
                updateCommand(index, { args: sanitizedArgs(event.currentTarget.value) })}
            />
          </div>
          <div class="flex shrink-0 items-center">
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
              title={`Move command ${index + 1} up`}
              aria-label={`Move command ${index + 1} up`}
              disabled={index === 0}
              onclick={() => moveCommand(index, -1)}
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
              title={`Move command ${index + 1} down`}
              aria-label={`Move command ${index + 1} down`}
              disabled={index === commands.length - 1}
              onclick={() => moveCommand(index, 1)}
            >
              <ChevronDown size={14} />
            </button>
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger"
              title={`Remove command ${index + 1}`}
              aria-label={`Remove command ${index + 1}`}
              onclick={() => (removalIndex = index)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </li>
      {/each}
    </ol>
  {:else}
    <div class="rounded-lg border border-dashed bg-elevated px-3 py-2.5 text-xs text-dimmed">
      No setup commands yet. Add the executable and arguments below.
    </div>
  {/if}

  <div class="flex items-center gap-2">
    <label class="sr-only" for={`${componentId}-setup-command-executable`}>Setup executable</label>
    <input
      id={`${componentId}-setup-command-executable`}
      class="w-36 rounded-lg border bg-elevated px-2.5 py-1.5 text-sm"
      placeholder="bun"
      bind:value={pendingExecutable}
      title="Executable name or path"
    />
    <label class="sr-only" for={`${componentId}-setup-command-args`}>Setup arguments</label>
    <input
      id={`${componentId}-setup-command-args`}
      class="min-w-0 flex-1 rounded-lg border bg-elevated px-2.5 py-1.5 text-sm"
      placeholder="--verbose install"
      bind:value={pendingArgs}
      title="Arguments (space-separated)"
      onkeydown={(event) => {
        if (event.key === 'Enter' && pendingExecutable.trim()) {
          event.preventDefault()
          addCommand()
        }
      }}
    />
    <button
      type="button"
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
      title="Add setup command"
      aria-label="Add setup command"
      disabled={!pendingExecutable.trim()}
      onclick={addCommand}
    >
      <Plus size={14} />
    </button>
  </div>
</div>

<Modal
  open={removalIndex !== null}
  title="Remove setup command"
  onClose={() => (removalIndex = null)}
>
  <p class="text-sm leading-relaxed text-muted">
    Remove command {removalIndex === null ? '' : removalIndex + 1} from this setup sequence? The other
    commands will keep their current order.
  </p>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      onclick={() => (removalIndex = null)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-danger/90"
      onclick={removeCommand}
    >
      Remove
    </button>
  {/snippet}
</Modal>
