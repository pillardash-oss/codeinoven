<script lang="ts">
  import { Plus, Trash2 } from '@lucide/svelte'
  import type { ScopeSetupCommandSpec } from '$shared/types'

  interface Props {
    commands: ScopeSetupCommandSpec[]
    onchange?: (commands: ScopeSetupCommandSpec[]) => void
  }

  let { commands = $bindable(), onchange }: Props = $props()

  let pendingExecutable = $state('')
  let pendingArgs = $state('')
  let confirmRemoval: ScopeSetupCommandSpec['executable'] | null = $state(null)

  function sanitizedArgs(value: string): string[] {
    return value
      .split(/\s+/u)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }

  function addCommand(): void {
    const executable = pendingExecutable.trim()
    if (!executable) return
    onchange?.([...commands, { executable, args: sanitizedArgs(pendingArgs) }])
    pendingExecutable = ''
    pendingArgs = ''
  }
</script>

<div class="space-y-2">
  <p class="text-xs font-medium text-muted">Setup commands</p>
  <ol class="space-y-1.5">
    {#each commands as command, index (index)}
      <li class="flex items-center gap-2 rounded-lg border bg-elevated px-3 py-2">
        <span class="w-5 shrink-0 text-right text-xs text-dimmed">{index + 1}</span>
        <code class="min-w-0 flex-1 truncate text-xs"
          >{command.executable}{command.args.length ? ` ${command.args.join(' ')}` : ''}</code
        >
        {#if confirmRemoval === command.executable}
          <button
            type="button"
            class="shrink-0 rounded px-2 py-1 text-xs text-danger hover:bg-danger/10"
            title="Confirm removal of setup command"
            aria-label="Confirm removal of setup command"
            onclick={() => {
              onchange?.(commands.filter((_, candidate) => candidate !== index))
              confirmRemoval = null
            }}
          >
            Confirm
          </button>
          <button
            type="button"
            class="shrink-0 text-xs text-muted hover:text-foreground"
            title="Cancel removal"
            aria-label="Cancel removal"
            onclick={() => (confirmRemoval = null)}
          >
            Cancel
          </button>
        {:else}
          <button
            type="button"
            class="shrink-0 text-muted transition-colors hover:text-danger"
            title="Remove setup command"
            aria-label="Remove setup command"
            onclick={() => (confirmRemoval = command.executable)}
          >
            <Trash2 size={14} />
          </button>
        {/if}
      </li>
    {/each}
  </ol>

  <div class="flex items-center gap-2">
    <label class="sr-only" for="setup-command-executable">Setup executable</label>
    <input
      id="setup-command-executable"
      class="w-36 rounded-lg border bg-elevated px-2.5 py-1.5 text-sm"
      placeholder="bun"
      bind:value={pendingExecutable}
      title="Executable name or path"
    />
    <label class="sr-only" for="setup-command-args">Setup arguments</label>
    <input
      id="setup-command-args"
      class="min-w-0 flex-1 rounded-lg border bg-elevated px-2.5 py-1.5 text-sm"
      placeholder="--verbose install"
      bind:value={pendingArgs}
      title="Arguments (space-separated)"
    />
    <button
      type="button"
      class="shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-sm text-on-primary hover:bg-primary-hover disabled:opacity-40"
      title="Add setup command"
      aria-label="Add setup command"
      disabled={!pendingExecutable.trim()}
      onclick={addCommand}
    >
      <Plus size={14} />
    </button>
  </div>
</div>
