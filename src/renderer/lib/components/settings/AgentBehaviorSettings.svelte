<script lang="ts">
  import { Check, ChevronDown, Loader2, Pencil, RotateCcw, Save, X } from '@lucide/svelte'
  import { DEFAULT_AGENT_BEHAVIOR_PROMPT } from '$shared/agent-behavior'
  import type { AppConfig, AppConfigPatch } from '$shared/types'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  let expanded = $state(false)
  let editing = $state(false)
  // Intentional initial draft snapshot; edits are refreshed when editing starts.
  // svelte-ignore state_referenced_locally
  let draft = $state(config.agentBehaviorPrompt)
  let saving = $state(false)
  let saved = $state(false)
  let error = $state('')
  let resetConfirmOpen = $state(false)

  function startEditing(): void {
    expanded = true
    draft = config.agentBehaviorPrompt
    error = ''
    saved = false
    editing = true
  }

  function cancelEditing(): void {
    draft = config.agentBehaviorPrompt
    error = ''
    editing = false
  }

  async function save(): Promise<void> {
    const next = draft.trim()
    if (!next) {
      error = 'Agent behavior cannot be empty. Use Reset to default if needed.'
      return
    }

    saving = true
    error = ''
    saved = false
    try {
      await updateConfig({ agentBehaviorPrompt: next })
      draft = next
      editing = false
      expanded = true
      saved = true
    } catch (saveError) {
      error = saveError instanceof Error ? saveError.message : 'Agent behavior could not be saved.'
    } finally {
      saving = false
    }
  }

  async function resetToDefault(): Promise<void> {
    saving = true
    error = ''
    saved = false
    try {
      await updateConfig({ agentBehaviorPrompt: DEFAULT_AGENT_BEHAVIOR_PROMPT })
      draft = DEFAULT_AGENT_BEHAVIOR_PROMPT
      editing = false
      expanded = true
      resetConfirmOpen = false
      saved = true
    } catch (resetError) {
      error =
        resetError instanceof Error ? resetError.message : 'Agent behavior could not be reset.'
    } finally {
      saving = false
    }
  }
</script>

<section class="mt-4 rounded-xl border bg-surface" aria-label="Agent behavior">
  <div class="flex items-start gap-4 p-4">
    <div class="min-w-0 flex-1">
      <h2 class="text-sm font-semibold text-foreground">Agent behavior</h2>
      <p class="mt-0.5 text-xs leading-relaxed text-muted">
        Default rules for implementation work.
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-1.5">
      {#if expanded && !editing}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
          title="Edit agent behavior"
          aria-label="Edit agent behavior"
          disabled={!settingsReady}
          onclick={startEditing}
        >
          <Pencil size={13} />
          Edit
        </button>
      {/if}
      <button
        type="button"
        class="rounded-lg p-1.5 text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title={expanded ? 'Collapse agent behavior' : 'Expand agent behavior'}
        aria-label={expanded ? 'Collapse agent behavior' : 'Expand agent behavior'}
        aria-expanded={expanded}
        onclick={() => (expanded = !expanded)}
      >
        <ChevronDown size={15} class={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
    </div>
  </div>

  {#if expanded && editing}
    <div class="p-4 pt-0">
      <textarea
        class="min-h-96 w-full resize-y rounded-lg border bg-elevated p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-primary disabled:opacity-50"
        bind:value={draft}
        disabled={saving}
        aria-label="Agent behavior prompt"></textarea>
      {#if error}<p class="mt-2 text-xs text-danger" role="alert">{error}</p>{/if}
      <div class="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
          title="Reset agent behavior to the application default"
          aria-label="Reset agent behavior to the application default"
          disabled={!settingsReady || saving || draft === DEFAULT_AGENT_BEHAVIOR_PROMPT}
          onclick={() => (resetConfirmOpen = true)}
        >
          <RotateCcw size={13} />
          Reset to default
        </button>
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
            title="Cancel agent behavior edit"
            aria-label="Cancel agent behavior edit"
            disabled={saving}
            onclick={cancelEditing}
          >
            <X size={13} />
            Cancel
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition-opacity hover:bg-primary-hover disabled:opacity-50"
            title="Save agent behavior"
            aria-label="Save agent behavior"
            disabled={!settingsReady || saving}
            onclick={() => void save()}
          >
            {#if saving}<Loader2 size={13} class="animate-spin" />{:else}<Save size={13} />{/if}
            Save
          </button>
        </div>
      </div>
    </div>
  {:else if expanded}
    <div class="px-4 pb-4">
      <p
        class="max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted"
      >
        {config.agentBehaviorPrompt}
      </p>
      {#if saved}
        <p class="mt-2 flex items-center gap-1 text-[11px] text-success" role="status">
          <Check size={12} /> Saved
        </p>
      {/if}
    </div>
  {/if}

  {#if error && !editing}<p class="px-4 pb-4 text-xs text-danger" role="alert">{error}</p>{/if}
</section>

<Modal
  open={resetConfirmOpen}
  title="Reset agent behavior?"
  onClose={() => (resetConfirmOpen = false)}
>
  <p class="text-sm leading-relaxed text-muted">
    This replaces your custom agent behavior with the application default. Your current prompt will
    not be recoverable from Settings after the reset.
  </p>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-elevated hover:text-foreground"
      onclick={() => (resetConfirmOpen = false)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
      disabled={saving}
      onclick={() => void resetToDefault()}
    >
      Reset behavior
    </button>
  {/snippet}
</Modal>
