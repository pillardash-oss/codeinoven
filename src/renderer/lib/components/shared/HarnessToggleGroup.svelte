<script lang="ts">
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { ArrowUpCircle, CheckCircle2 } from '@lucide/svelte'

  interface HarnessOption {
    id: string
    name: string
    /** The Oven already runs this harness. */
    installed?: boolean
    /** A newer version is published than the Oven runs. */
    updateAvailable?: boolean
  }

  interface Props {
    options: HarnessOption[]
    /** Selected harness ids. A provider can now link the same config across several harnesses. */
    value: string[]
    /** Toggles a single harness id in or out of the selection. */
    onToggle: (id: string) => void
    disabled?: boolean
    label?: string
    /** Optional bulk selection action. */
    onToggleAll?: () => void
  }

  let { options, value, onToggle, disabled = false, label, onToggleAll }: Props = $props()
  const allSelected = $derived(
    options.length > 0 && options.every((option) => value.includes(option.id))
  )

  /** What the Oven already has, so a user can tell install from update. */
  function optionTitle(option: HarnessOption): string {
    const state = option.updateAvailable
      ? 'Update available'
      : option.installed
        ? 'Installed on the Oven'
        : 'Not installed'
    return `${option.name} · ${state}`
  }
</script>

{#if label}<span class="text-xs font-medium">{label}</span>{/if}
<div class="flex min-h-9 flex-wrap gap-1.5" role="group" aria-label={label ?? 'Select harnesses'}>
  {#if onToggleAll}
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {allSelected
        ? 'border-primary bg-primary text-on-primary'
        : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
      {disabled}
      aria-pressed={allSelected}
      onclick={onToggleAll}>All</button
    >
  {/if}
  {#each options as option (option.id)}
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {value.includes(
        option.id
      )
        ? 'border-primary bg-primary text-on-primary'
        : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
      {disabled}
      title={optionTitle(option)}
      aria-pressed={value.includes(option.id)}
      onclick={() => onToggle(option.id)}
    >
      <AgentIcon agentId={option.id} label={option.name} size={14} />
      {option.name}
      {#if option.updateAvailable}
        <ArrowUpCircle size={12} class="shrink-0 text-info" />
      {:else if option.installed}
        <CheckCircle2 size={12} class="shrink-0 text-success" />
      {/if}
    </button>
  {/each}
</div>
