<script lang="ts">
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'

  interface HarnessOption {
    id: string
    name: string
  }

  interface Props {
    options: HarnessOption[]
    value: string
    onchange: (id: string) => void
    disabled?: boolean
    label?: string
  }

  let { options, value, onchange, disabled = false, label }: Props = $props()
</script>

{#if label}<span class="text-xs font-medium">{label}</span>{/if}
<div class="flex min-h-9 flex-wrap gap-1.5" role="group" aria-label={label ?? 'Select harness'}>
  {#each options as option (option.id)}
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {value ===
      option.id
        ? 'border-primary bg-primary text-on-primary'
        : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
      {disabled}
      aria-pressed={value === option.id}
      onclick={() => onchange(option.id)}
    >
      <AgentIcon agentId={option.id} label={option.name} size={14} />
      {option.name}
    </button>
  {/each}
</div>
