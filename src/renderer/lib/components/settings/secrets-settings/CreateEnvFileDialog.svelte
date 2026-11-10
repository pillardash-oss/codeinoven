<script lang="ts">
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import {
    PROJECT_ENV_MODES,
    projectEnvModeFileName,
    type ProjectEnvMode
  } from '$shared/project-env'
  import Modal from '../../ui/Modal.svelte'

  /**
   * Create one managed env file: a directory group plus a run mode.
   *
   * The group is what makes a monorepo work: `packages/api` gets its own file, and a
   * process started there sees the group's keys on top of the project root's.
   */
  interface Props {
    group: string
    mode: ProjectEnvMode
    busy?: boolean
    onCreate: () => void | Promise<void>
    onClose: () => void
  }

  let { group = $bindable(), mode = $bindable(), busy = false, onCreate, onClose }: Props = $props()

  const preview = $derived(
    `${group.trim().replace(/^\/+|\/+$/gu, '') || '.'}/${projectEnvModeFileName(mode)}`
  )
</script>

<Modal open={true} title="New env file" {onClose} size="md">
  <div class="space-y-4">
    <label class="block text-xs font-medium text-muted" for="env-new-group">
      Directory, relative to the project
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

    <label class="block text-xs font-medium text-muted" for="env-new-mode">
      Run mode
      <select
        id="env-new-mode"
        class="mt-1 h-9 w-full border bg-elevated px-2 text-sm outline-none focus:border-primary"
        value={mode}
        onchange={(event) => (mode = event.currentTarget.value as ProjectEnvMode)}
      >
        {#each PROJECT_ENV_MODES as candidate (candidate)}
          <option value={candidate}>{projectEnvModeFileName(candidate)}</option>
        {/each}
      </select>
    </label>

    <p class="text-[0.6875rem] text-dimmed">
      Creates <span class="font-mono text-foreground">{preview}</span>. A later mode overrides an
      earlier one in the same directory, and a deeper directory overrides the project root.
    </p>
  </div>

  {#snippet footer()}
    <button type="button" class="border px-3 py-1.5 text-sm" onclick={onClose}>Cancel</button>
    <button
      type="button"
      class="bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={busy}
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
