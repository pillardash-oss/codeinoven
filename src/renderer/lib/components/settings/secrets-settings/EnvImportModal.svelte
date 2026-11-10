<script lang="ts">
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { ProjectEnvImportPreview } from '$shared/project-env'
  import Modal from '../../ui/Modal.svelte'

  /**
   * Import a plaintext ENV file into the vault.
   *
   * The review is the point of this dialog: the user sees which keys are created,
   * which are replaced, what the file will look like afterwards, and which lines
   * were left alone, before anything is written. Applying keeps a 0600 backup of the
   * original beside it.
   */
  interface Props {
    group: string
    fileName: string
    busy?: boolean
    error?: string
    preview: ProjectEnvImportPreview | null
    onPreview: (path: string) => void | Promise<void>
    onApply: (path: string) => void | Promise<void>
    onClose: () => void
  }

  let {
    group,
    fileName,
    busy = false,
    error = '',
    preview,
    onPreview,
    onApply,
    onClose
  }: Props = $props()

  /** The file this name lives in, used until the user types another path. */
  function defaultPath(): string {
    return `${group ? `${group}/` : ''}${fileName}`
  }

  let override = $state<string | null>(null)
  const path = $derived(override ?? defaultPath())

  const canImport = $derived(path.trim().length > 0 && !busy)
</script>

<Modal open={true} title="Import an env file" {onClose} size="lg">
  <div class="space-y-4">
    <label class="block text-xs font-medium text-muted" for="env-import-path">
      File, relative to the project
      <input
        id="env-import-path"
        class="mt-1 h-9 w-full border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
        type="text"
        autocomplete="off"
        spellcheck="false"
        value={path}
        oninput={(event) => (override = event.currentTarget.value)}
      />
    </label>

    <div class="flex items-center gap-2">
      <button
        type="button"
        class="border px-3 py-1.5 text-sm hover:bg-elevated disabled:opacity-40"
        disabled={!canImport}
        onclick={() => void onPreview(path.trim())}
      >
        Read and review
      </button>
      <p class="text-[0.6875rem] text-dimmed">
        Nothing is written until you import, and the original is kept as a 0600 backup.
      </p>
    </div>

    {#if error}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}

    {#if preview}
      <div class="space-y-3 border bg-surface p-3">
        <p class="text-xs text-muted">
          <span class="font-mono text-foreground">{preview.path}</span>
          will keep
          <span class="font-medium text-foreground tabular-nums">{preview.names.length}</span>
          {preview.names.length === 1 ? 'key' : 'keys'}:
          <span class="tabular-nums">{preview.created.length}</span> new,
          <span class="tabular-nums">{preview.replaced.length}</span> replaced.
        </p>

        <div>
          <p class="mb-1 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">
            The file afterwards
          </p>
          <pre
            class="max-h-56 overflow-auto border bg-app p-3 font-mono text-[0.6875rem] leading-relaxed text-foreground">{preview.rewritten}</pre>
        </div>

        {#if preview.skipped.length > 0}
          <div>
            <p class="mb-1 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">
              Left alone
            </p>
            <ul class="space-y-1">
              {#each preview.skipped as entry (entry.line)}
                <li class="text-[0.6875rem] text-muted">
                  Line {entry.line}: {entry.reason}
                </li>
              {/each}
            </ul>
          </div>
        {/if}

        <p class="text-[0.6875rem] text-dimmed">
          References are assigned when the import runs, so the ids here show the shape, not the
          final ones.
        </p>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="border px-3 py-1.5 text-sm" onclick={onClose}>Cancel</button>
    <button
      type="button"
      class="bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={!canImport || preview === null}
      data-modal-primary
      onclick={() => void onApply(path.trim())}
    >
      {#if busy}
        <CioSpinner size={13} class="mr-1 inline animate-spin" aria-hidden="true" />
      {/if}
      Import and rewrite
    </button>
  {/snippet}
</Modal>
