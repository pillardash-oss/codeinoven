<script lang="ts">
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import {
    DEFAULT_ENV_FILE_NAME,
    isEnvFileNameTaken,
    SUGGESTED_ENV_FILE_NAMES,
    suggestEnvFileName,
    validateEnvFileName
  } from '$shared/project-env'
  import Modal from '../../ui/Modal.svelte'

  /**
   * Create one env file at a chosen path.
   *
   * The directory is the path the user opened the surface for, and the name is
   * theirs to type: this is where a `.env.production`, a `.env.selfhost` or anything
   * else they run with begins. A path holds one file, so a name the directory
   * already uses is refused here instead of silently opening the file that is
   * already there.
   */
  interface Props {
    /** Project-relative directory the file belongs to, '' for the project root. */
    group: string
    /** Initial name, editable. */
    name: string
    /** Every env file the project already has, so a taken path is caught here. */
    existing: readonly { group: string; fileName: string }[]
    busy?: boolean
    error?: string
    onCreate: () => void | Promise<void>
    onClose: () => void
  }

  let {
    group = $bindable(),
    name = $bindable(DEFAULT_ENV_FILE_NAME),
    existing,
    busy = false,
    error = '',
    onCreate,
    onClose
  }: Props = $props()

  const normalizedGroup = $derived(group.trim().replace(/^\/+|\/+$/gu, ''))
  const takenNames = $derived(
    existing.filter((file) => file.group === normalizedGroup).map((file) => file.fileName)
  )
  const trimmedName = $derived(name.trim())
  const preview = $derived(`${normalizedGroup || '.'}/${trimmedName}`)

  const nameError = $derived.by(() => {
    if (!trimmedName) return ''
    try {
      validateEnvFileName(trimmedName)
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'That name cannot be used'
    }
    if (isEnvFileNameTaken(takenNames, trimmedName)) {
      return `${normalizedGroup || 'The project root'} already has ${trimmedName}. Use ${suggestEnvFileName(takenNames)} for a second file.`
    }
    return ''
  })
  const canCreate = $derived(!busy && !nameError && trimmedName.length > 0)
</script>

<Modal open={true} title="New env file" {onClose} size="md">
  <div class="space-y-4">
    <label class="block text-xs font-medium text-muted" for="env-new-group">
      Path, relative to the project
      <input
        id="env-new-group"
        class="mt-1 h-9 w-full border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="Leave empty for the project root"
        value={group}
        oninput={(event) => (group = event.currentTarget.value)}
      />
    </label>

    <label class="block text-xs font-medium text-muted" for="env-new-name">
      File name
      <input
        id="env-new-name"
        class="mt-1 h-9 w-full border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder={DEFAULT_ENV_FILE_NAME}
        value={name}
        oninput={(event) => (name = event.currentTarget.value)}
      />
    </label>

    <div class="space-y-1.5">
      <p class="text-xs font-medium text-muted">Common names</p>
      <div class="flex flex-wrap gap-1">
        {#each SUGGESTED_ENV_FILE_NAMES as suggestion (suggestion)}
          {@const taken = isEnvFileNameTaken(takenNames, suggestion)}
          <button
            type="button"
            class="border px-2 py-0.5 font-mono text-[0.6875rem] {taken
              ? 'text-dimmed'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            disabled={taken || busy}
            aria-pressed={trimmedName === suggestion}
            title={taken
              ? `${suggestion} already exists in ${normalizedGroup || 'the project root'}`
              : `Name the new file ${suggestion}`}
            onclick={() => (name = suggestion)}
          >
            {suggestion}
            {#if taken}<span class="ml-1 text-dimmed">taken</span>{/if}
          </button>
        {/each}
      </div>
      {#if takenNames.length > 0}
        <p class="text-[0.6875rem] text-dimmed">
          Already here:
          <span class="font-mono text-muted">{takenNames.join(', ')}</span>
        </p>
      {/if}
    </div>

    {#if nameError}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{nameError}</p>
    {:else}
      <p class="text-[0.6875rem] text-dimmed">
        Creates <span class="font-mono text-foreground">{preview}</span>. A file named `.env` is
        applied before any other name in its directory; the rest follow by name.
      </p>
    {/if}

    {#if error}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="border px-3 py-1.5 text-sm" data-modal-dismiss onclick={onClose}>
      Cancel
    </button>
    <button
      type="button"
      class="bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={!canCreate}
      data-modal-primary
      onclick={() => void onCreate()}
    >
      {#if busy}
        <CioSpinner size={13} class="mr-1 inline animate-spin" aria-hidden="true" />
      {/if}
      Create
    </button>
  {/snippet}
</Modal>
