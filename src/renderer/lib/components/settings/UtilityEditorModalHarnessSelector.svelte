<script lang="ts">
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { ALL_HARNESSES_BINDING_ID } from '$shared/types'
  import type { BindingDraft } from './utility-editor-modal-helpers'

  interface Props {
    bindings: BindingDraft[]
    availableHarnesses: Array<{ id: string; name: string }>
    /** Inerts the chips while a save is in flight, so a stray Cmd/Ctrl+Enter
     *  cannot retarget the draft as the form is being written. */
    disabled?: boolean
    /** Fieldset title, so a native skill and a registry utility can both name
     *  what the selection decides. */
    legend?: string
    /** One line under the title explaining what the selection does here. */
    description?: string
    onSelectAll: () => void
    onToggleHarness: (harnessId: string) => void
  }

  let {
    bindings,
    availableHarnesses,
    disabled = false,
    legend = 'Available to',
    description = 'All is selected by default and automatically includes harnesses added later. Choose individual harnesses only when this utility should have limited availability.',
    onSelectAll,
    onToggleHarness
  }: Props = $props()

  const allSelected = $derived(
    bindings.some((binding) => binding.harnessId === ALL_HARNESSES_BINDING_ID)
  )

  function isSelected(harnessId: string): boolean {
    return bindings.some((binding) => binding.harnessId === harnessId)
  }
</script>

<fieldset class="space-y-3 rounded-xl border p-3">
  <legend class="px-1 text-xs font-semibold">{legend}</legend>
  <p class="text-[0.6875rem] text-dimmed">
    {description}
  </p>
  <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
    <button
      type="button"
      class="flex h-10 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors {allSelected
        ? 'border-primary bg-primary text-on-primary'
        : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
      aria-pressed={allSelected}
      title="Apply to all current and future harnesses"
      {disabled}
      onclick={onSelectAll}
    >
      All
    </button>
    {#if availableHarnesses.length}
      {#each availableHarnesses as harness (harness.id)}
        <button
          type="button"
          class="flex h-10 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors {isSelected(
            harness.id
          )
            ? 'border-primary bg-primary text-on-primary'
            : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
          aria-pressed={isSelected(harness.id)}
          {disabled}
          onclick={() => onToggleHarness(harness.id)}
        >
          <AgentIcon agentId={harness.id} label={harness.name} size={16} />
          {harness.name}
        </button>
      {/each}
    {/if}
  </div>
  {#if !availableHarnesses.length}
    <div class="rounded-lg bg-raised px-3 py-2">
      <p class="text-xs text-muted">
        No installed, supported harnesses were detected. All harnesses will still apply when one is
        added later.
      </p>
    </div>
  {/if}
</fieldset>
