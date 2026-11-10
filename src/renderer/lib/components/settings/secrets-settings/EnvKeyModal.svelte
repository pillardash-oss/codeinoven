<script lang="ts">
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import Modal from '../../ui/Modal.svelte'
  import SecretVisibilityButton from '../../shared/SecretVisibilityButton.svelte'

  /**
   * Add or replace one project ENV value.
   *
   * The name is fixed while replacing: a value belongs to a name, and renaming it
   * is done by adding the new name and deleting the old one.
   */
  interface Props {
    /** The key being edited, or null when adding a new one. */
    existing: { name: string } | null
    /** File the value is being written to, shown so the target is never a guess. */
    group: string
    fileName: string
    /** Replaces the default "written to <file>" line, e.g. for a thread-scoped key. */
    description?: string
    busy?: boolean
    error?: string
    onSubmit: (input: { name: string; value: string }) => void | Promise<void>
    onClose: () => void
  }

  let {
    existing,
    group,
    fileName,
    description,
    busy = false,
    error = '',
    onSubmit,
    onClose
  }: Props = $props()

  /** The key being edited owns the name; a new key types it. */
  let draftName = $state('')
  const name = $derived(existing ? existing.name : draftName)
  let value = $state('')
  let revealed = $state(false)

  const target = $derived(`${group || '.'}/${fileName}`)
  const canSubmit = $derived(name.trim().length > 0 && value.length > 0 && !busy)

  async function submit(): Promise<void> {
    if (!canSubmit) return
    await onSubmit({ name: name.trim(), value })
  }
</script>

<Modal open={true} title={existing ? 'Replace value' : 'Add env key'} {onClose} size="md">
  <div class="space-y-4">
    <p class="text-xs text-muted">
      {#if description}
        {description}
      {:else}
        Written to <span class="font-mono text-foreground">{target}</span>. The file keeps a
        reference; the value stays encrypted and is never shown again.
      {/if}
    </p>

    <label class="block text-xs font-medium text-muted" for="env-key-name">
      Key
      <input
        id="env-key-name"
        class="mt-1 h-9 w-full border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary disabled:opacity-60"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="DATABASE_URL"
        value={name}
        disabled={existing !== null}
        oninput={(event) => (draftName = event.currentTarget.value)}
      />
    </label>

    <label class="block text-xs font-medium text-muted" for="env-key-value">
      Value
      <div class="mt-1 flex items-center gap-1">
        <input
          id="env-key-value"
          class="h-9 min-w-0 flex-1 border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
          type={revealed ? 'text' : 'password'}
          autocomplete="off"
          spellcheck="false"
          {value}
          oninput={(event) => (value = event.currentTarget.value)}
          onkeydown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
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
      {existing ? 'Replace' : 'Add key'}
    </button>
  {/snippet}
</Modal>
