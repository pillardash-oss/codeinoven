<script lang="ts">
  import { AppWindow, Check, ChevronDown } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { EditorId } from '$shared/types'

  let showEditorMenu = $state(false)

  /** Only editors actually installed on this machine are offered. */
  let availableEditors = $derived(editorPreference.availableEditors)

  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')

  let preferredIcon = $derived(editorPreference.preferredInfo?.iconDataUrl)

  async function openProjectInEditor(): Promise<void> {
    const project = workspaceState.activeProject
    if (project?.id) {
      await invoke('project:openInEditor', project.id)
    }
  }

  async function selectEditor(id: EditorId): Promise<void> {
    showEditorMenu = false
    if (id === editorPreference.preferredEditor) return
    await editorPreference.select(id)
    await openProjectInEditor()
  }
</script>

<!-- Editor preference   hidden in chat mode, scope view, and when no project is selected -->
<div class="relative flex items-center">
  <button
    class="flex h-8 w-8 items-center justify-center text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
    aria-label="Open in {preferredName}"
    title="Open in {preferredName}"
    onclick={() => void openProjectInEditor()}
  >
    {#if preferredIcon}
      <img src={preferredIcon} alt="" class="h-4 w-4" />
    {:else}
      <AppWindow size={16} />
    {/if}
  </button>
  <button
    class="flex h-8 items-center px-1 text-dimmed transition-colors duration-150 hover:bg-elevated hover:text-foreground"
    aria-label="Select preferred editor"
    aria-haspopup="menu"
    aria-expanded={showEditorMenu}
    title="Select preferred editor"
    onclick={() => (showEditorMenu = !showEditorMenu)}
  >
    <ChevronDown size={12} />
  </button>

  {#if showEditorMenu}
    <button
      class="fixed inset-0 z-30 cursor-default"
      aria-label="Close menu"
      onclick={() => (showEditorMenu = false)}
    ></button>
    <div
      class="absolute right-0 top-9 z-40 w-48 overflow-hidden border bg-surface p-1 shadow-lg"
      role="menu"
      aria-label="Select default editor"
    >
      <p
        class="px-2.5 py-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-dimmed"
      >
        Open projects in
      </p>
      {#each availableEditors as editor (editor.id)}
        <button
          class="flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-elevated"
          role="menuitemradio"
          aria-checked={editorPreference.preferredEditor === editor.id}
          title="Open projects in {editor.name}"
          onclick={() => void selectEditor(editor.id)}
        >
          {#if editor.iconDataUrl}
            <img src={editor.iconDataUrl} alt="" class="h-4.5 w-4.5 shrink-0" />
          {:else}
            <AppWindow size={16} class="shrink-0 text-muted" />
          {/if}
          <span class="flex-1 truncate">{editor.name}</span>
          {#if editorPreference.preferredEditor === editor.id}
            <Check size={14} class="text-primary" />
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
