<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import ContinueInProjectModal from '$lib/components/threads/ContinueInProjectModal.svelte'
  import type { AssistantHandoff } from './assistant-handoff.svelte'

  interface Props {
    controller: AssistantHandoff
  }

  let { controller }: Props = $props()
</script>

<Modal
  open={controller.confirmOpen}
  title="Hand off while running?"
  onClose={controller.cancelConfirm}
>
  <p class="text-[0.75rem] text-muted">
    This task is running right now. Handing it off forks the thread into a project while the run is
    still writing to it. Continue anyway?
  </p>
  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      onclick={controller.cancelConfirm}
    >
      Cancel
    </button>
    <button
      type="button"
      data-modal-primary
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      onclick={controller.confirm}
    >
      Continue
    </button>
  {/snippet}
</Modal>

<ContinueInProjectModal
  open={controller.pickerOpen}
  projects={controller.projects}
  projectIcons={controller.projectIcons}
  busy={controller.busy}
  onClose={controller.closePicker}
  onContinue={(project) => void controller.continueInProject(project)}
  onProjectCreated={(project) => controller.addProject(project)}
/>
