<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import type { Project } from '$shared/types'
  import type { WorkspaceBrowserController } from './WorkspaceBrowserController.svelte'

  interface Props {
    browser: WorkspaceBrowserController
    projects: Project[]
  }

  let { browser, projects }: Props = $props()
</script>

<Modal
  open={browser.clearDataConfirmOpen}
  title="Clear browser data?"
  onClose={() => browser.cancelDataClear()}
  closeOnBackdrop={!browser.clearing}
>
  <p class="text-sm leading-relaxed text-muted">
    This clears cookies, local storage, service workers, caches, and other site data for
    <span class="font-medium text-foreground"
      >{projects.find((project) => project.id === browser.clearDataProjectId)?.name ??
        'this project'}</span
    >. Browser tabs will reload and signed-in sessions may end.
  </p>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated disabled:opacity-50"
      title="Keep browser data"
      disabled={browser.clearing}
      onclick={() => browser.cancelDataClear()}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-on-danger transition-colors hover:bg-danger-hover disabled:opacity-50"
      title="Clear browser cookies and site data"
      disabled={browser.clearing}
      onclick={() => void browser.clearData()}
    >
      {browser.clearing ? 'Clearing…' : 'Clear data'}
    </button>
  {/snippet}
</Modal>
