<script lang="ts">
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { SecretInventoryEntry } from '$shared/secrets'
  import Modal from '../../ui/Modal.svelte'
  import SecretVisibilityButton from '../../shared/SecretVisibilityButton.svelte'

  /**
   * Replace one stored secret in place.
   *
   * The value never comes back from the main process, so this dialog is the only
   * way to change one: the user types a new value and the vault is overwritten at
   * the same reference every owner already holds.
   */
  interface Props {
    /** The row being replaced. The dialog is mounted per row, so its entry is live. */
    entry: SecretInventoryEntry
    busy?: boolean
    error?: string
    onSubmit: (value: string) => void | Promise<void>
    onClose: () => void
  }

  let { entry, busy = false, error = '', onSubmit, onClose }: Props = $props()

  let value = $state('')
  let revealed = $state(false)

  const canSubmit = $derived(value.length > 0 && !busy)

  async function submit(): Promise<void> {
    if (!canSubmit) return
    await onSubmit(value)
  }
</script>

<Modal open={true} title="Replace secret" {onClose} size="md">
  <div class="space-y-4">
    <p class="text-xs text-muted">
      A new value replaces the one stored for
      <span class="font-medium text-foreground">{entry.title}</span>. Nothing is ever shown again
      after it is saved.
    </p>

    <label class="block text-xs font-medium text-muted" for="secret-rotate-value">
      New value
      <div class="mt-1 flex items-center gap-1">
        <input
          id="secret-rotate-value"
          class="h-9 min-w-0 flex-1 border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
          type={revealed ? 'text' : 'password'}
          autocomplete="off"
          spellcheck="false"
          {value}
          oninput={(event) => (value = event.currentTarget.value)}
        />
        <SecretVisibilityButton
          {revealed}
          title={revealed ? 'Hide the value' : 'Show the value'}
          onclick={() => (revealed = !revealed)}
        />
      </div>
    </label>

    {#if error}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="border px-3 py-1.5 text-sm" onclick={onClose}>Cancel</button>
    <button
      type="button"
      class="bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={!canSubmit}
      data-modal-primary
      onclick={() => void submit()}
    >
      {#if busy}
        <CioSpinner size={13} class="mr-1 inline animate-spin" aria-hidden="true" />
      {/if}
      Replace
    </button>
  {/snippet}
</Modal>
