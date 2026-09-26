<script lang="ts">
  import { FolderOpen } from '@lucide/svelte'
  import type { SvelteMap } from 'svelte/reactivity'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import type { WorkspaceProjectDialogs } from './WorkspaceProjectDialogs.svelte'

  interface Props {
    dialogs: WorkspaceProjectDialogs
    /** Icon data-URL cache keyed by project id. */
    projectIcons: SvelteMap<string, string>
  }

  let { dialogs, projectIcons }: Props = $props()
</script>

<!-- Edit Project Modal -->
<Modal
  open={dialogs.showEditModal}
  title="Edit Project"
  onClose={() => (dialogs.showEditModal = false)}
  size="lg"
>
  {#if dialogs.editProject}
    <form
      id="edit-project-form"
      class="space-y-4"
      onsubmit={(e: SubmitEvent) => void dialogs.confirmEditProject(e)}
    >
      <AppearancePicker
        name={dialogs.editProjectName}
        color={dialogs.editProjectColor}
        iconType={dialogs.editProjectIconType}
        customSvg={dialogs.editProjectCustomSvg}
        allowCustomSvg
        fallbackIconUrl={dialogs.editProjectCustomSvgSelected
          ? null
          : (dialogs.editProjectPendingIcon?.dataUrl ??
            (dialogs.editProject.icon ? (projectIcons.get(dialogs.editProject.id) ?? null) : null))}
        onColorChange={(color) => (dialogs.editProjectColor = color)}
        onIconTypeChange={(iconType) => (dialogs.editProjectIconType = iconType)}
        onCustomSvgChange={(svg) => {
          dialogs.editProjectCustomSvg = svg
          dialogs.editProjectCustomSvgSelected = Boolean(svg)
        }}
        onReset={() => {
          dialogs.editProjectColor = dialogs.editProject?.color
          dialogs.editProjectIconType = dialogs.editProject?.iconType
          dialogs.editProjectCustomSvg = dialogs.editProject?.customSvg
          dialogs.editProjectCustomSvgSelected = false
          dialogs.editProjectPendingIcon = undefined
        }}
      />

      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Upload a custom image as the project icon"
        onclick={() => void dialogs.changeEditProjectIcon()}
      >
        <FolderOpen size={12} />
        Upload Image
      </button>

      <!-- Project name -->
      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="edit-project-name">
          Project Name
        </label>
        <input
          id="edit-project-name"
          type="text"
          class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
          bind:value={dialogs.editProjectName}
        />
      </div>

      <!-- Project path -->
      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="edit-project-path">
          Project Path
        </label>
        <input
          id="edit-project-path"
          type="text"
          class="w-full rounded-lg border bg-raised px-3 py-2 text-sm text-dimmed"
          value={dialogs.editProject.path}
          readonly
        />
      </div>
    </form>
  {/if}

  {#snippet footer()}
    {#if dialogs.editProject}
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
        title="Cancel"
        onclick={() => (dialogs.showEditModal = false)}
      >
        Cancel
      </button>
      <button
        type="submit"
        form="edit-project-form"
        class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
        disabled={!dialogs.editProjectName.trim()}
        title="Save project settings"
      >
        Save
      </button>
    {/if}
  {/snippet}
</Modal>
