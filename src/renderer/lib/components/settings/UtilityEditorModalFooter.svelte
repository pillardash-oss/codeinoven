<script lang="ts">
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  interface Props {
    setupPreset: string | null
    isNative: boolean
    hasDraftId: boolean
    isAppOwned: boolean
    /**
     * The draft has nothing an editor may change, so the footer offers no save:
     * a built-in utility's section is shown for reading, not for editing.
     */
    readOnly?: boolean
    saving: boolean
    canImportPlugin: boolean
    onBack: () => void
    onClose: () => void
    onImportPlugin: () => void
    onRequestDelete: () => void
  }

  let {
    setupPreset,
    isNative,
    hasDraftId,
    isAppOwned,
    readOnly = false,
    saving,
    canImportPlugin,
    onBack,
    onClose,
    onImportPlugin,
    onRequestDelete
  }: Props = $props()

  const showBack = $derived(!isNative && !hasDraftId && setupPreset !== null)
</script>

<div class="flex w-full items-center justify-between gap-2">
  <div class="flex items-center gap-2">
    {#if showBack}
      <button
        class="flex h-9 items-center gap-1.5 px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground"
        type="button"
        data-modal-dismiss
        onclick={onBack}
      >
        <CioBack size={14} /> Back
      </button>
    {/if}
    {#if setupPreset === 'plugin-bundle'}
      <button
        class="h-9 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
        type="button"
        data-modal-dismiss
        onclick={onClose}
      >
        Cancel
      </button>
    {:else}
      <button
        class="h-9 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
        type="button"
        data-modal-dismiss
        onclick={onClose}
      >
        {hasDraftId || isNative || setupPreset !== null ? (readOnly ? 'Close' : 'Cancel') : 'Close'}
      </button>
      {#if (hasDraftId || isNative) && !isAppOwned}
        <button
          class="flex h-9 items-center gap-1.5 bg-danger px-3 text-xs font-medium text-on-danger hover:bg-danger-hover disabled:opacity-50"
          type="button"
          disabled={saving}
          onclick={onRequestDelete}
        >
          {#if saving}<CioSpinner size={13} class="animate-spin" />{/if}
          Delete
        </button>
      {/if}
    {/if}
  </div>
  <div class="flex items-center gap-2">
    {#if setupPreset === 'plugin-bundle'}
      <button
        class="flex h-9 items-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
        type="button"
        data-modal-primary
        disabled={saving || !canImportPlugin}
        onclick={onImportPlugin}
      >
        {#if saving}<CioSpinner size={13} class="animate-spin" />{/if}
        Install plugin
      </button>
    {:else if (hasDraftId || isNative || setupPreset !== null) && !readOnly}
      <button
        class="flex h-9 items-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
        type="submit"
        form="utility-editor-form"
        data-modal-primary
        disabled={saving}
      >
        {#if saving}<CioSpinner size={13} class="animate-spin" />{/if}
        {isNative ? 'Save changes' : 'Save utility'}
      </button>
    {/if}
  </div>
</div>
