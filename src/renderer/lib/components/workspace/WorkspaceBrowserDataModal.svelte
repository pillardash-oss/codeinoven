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
      class="px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Keep browser data"
      onclick={() => browser.cancelDataClear()}
    >
      Cancel
    </button>
    <button
      type="button"
      class="bg-danger px-4 py-2 text-sm font-medium text-on-danger transition-colors hover:bg-danger-hover"
      title="Clear browser cookies and site data"
      onclick={() => browser.clearData()}
    >
      Clear data
    </button>
  {/snippet}
</Modal>
