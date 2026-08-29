<script lang="ts">
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'

  interface HarnessOption {
    id: string
    name: string
  }

  interface Props {
    options: HarnessOption[]
    /** Selected harness ids. A provider can now link the same config across several harnesses. */
    value: string[]
    /** Toggles a single harness id in or out of the selection. */
    onToggle: (id: string) => void
    disabled?: boolean
    label?: string
  }

  let { options, value, onToggle, disabled = false, label }: Props = $props()
</script>

{#if label}<span class="text-xs font-medium">{label}</span>{/if}
<div class="flex min-h-9 flex-wrap gap-1.5" role="group" aria-label={label ?? 'Select harnesses'}>
  {#each options as option (option.id)}
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {value.includes(
        option.id
      )
        ? 'border-primary bg-primary text-on-primary'
        : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
      {disabled}
      aria-pressed={value.includes(option.id)}
      onclick={() => onToggle(option.id)}
    >
      <AgentIcon agentId={option.id} label={option.name} size={14} />
      {option.name}
    </button>
  {/each}
</div>
