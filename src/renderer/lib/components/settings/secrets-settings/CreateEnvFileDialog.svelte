<script lang="ts">
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { DEFAULT_ENV_FILE_NAME } from '$shared/project-env'
  import Modal from '../../ui/Modal.svelte'

  /**
   * Create one env file at a chosen path.
   *
   * The directory is the path the user opened the surface for, and the name is
   * theirs to type: this is where a `.env.production`, a `.env.selfhost` or anything
   * else they run with begins.
   */
  interface Props {
    /** Project-relative directory the file belongs to, '' for the project root. */
    group: string
    /** Initial name, editable. */
    name: string
    busy?: boolean
    onCreate: () => void | Promise<void>
    onClose: () => void
  }

  let {
    group = $bindable(),
    name = $bindable(DEFAULT_ENV_FILE_NAME),
    busy = false,
    onCreate,
    onClose
  }: Props = $props()

  const preview = $derived(`${group.trim().replace(/^\/+|\/+$/gu, '') || '.'}/${name.trim()}`)
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

    <p class="text-[0.6875rem] text-dimmed">
      Creates <span class="font-mono text-foreground">{preview}</span>. A file named `.env` is
      applied before any other name in its directory; the rest follow by name.
    </p>
  </div>

  {#snippet footer()}
    <button type="button" class="border px-3 py-1.5 text-sm" onclick={onClose}>Cancel</button>
    <button
      type="button"
      class="bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={busy || !name.trim()}
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
