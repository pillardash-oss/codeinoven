<script lang="ts">
  import { Minimize2, X } from '@lucide/svelte'

  import Modal from '../ui/Modal.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import StandaloneFilePane from './StandaloneFilePane.svelte'
  import StandaloneFileTabs from './StandaloneFileTabs.svelte'

  /**
   * Fullscreen reader/editor for files opened through the operating system
   * ("Open in CodeInOven"). It is the explicit "full screen" mode of the docked
   * panel (`StandaloneFileDock`), which is where these files open by default so
   * the workspace stays usable. A header action docks the file back into the
   * floating panel.
   *
   * It is intentionally project-less: with no project there is no file tree, no
   * tree operations, and no directory index to read or hold in memory   only
   * the single file on screen. Text and code are editable and saved straight
   * back to the file they came from; the preview modes mirror the project editor,
   * so every file type the editor can preview previews here too.
   */
  const active = $derived(standaloneFiles.active)
  const open = $derived(standaloneFiles.open)

  // The browser renders a native `WebContentsView` that the compositor paints
  // above every DOM surface, so this full-window viewer must publish itself as a
  // fullscreen surface while it is up, exactly like the project's own
  // fullscreen file editor. Without this the still-attached browser view covers
  // the editor and its toolbar. Keyed distinctly from that editor so the two
  // overlapping surfaces never clear each other's registration, and cleared on
  // destroy so an unmount can never leave the view permanently suppressed.
  $effect(() => browserVisibility.hideWhile('standalone-file-viewer', 'fullscreen-surface', open))
</script>

<Modal
  {open}
  title={active?.name ?? 'File'}
  description="File opened on its own, without a project or file tree. Text is editable and saves straight back to the file."
  onClose={() => {
    if (active) standaloneFiles.requestClose(active.path)
  }}
  placement="fullscreen"
  chrome={false}
  panelClass="bg-app"
>
  <div
    class="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3"
    style={trafficLightInsetStyle()}
  >
    <span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
      {active?.name ?? 'File'}
    </span>
    <button
      type="button"
      class="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Dock this file into a floating panel"
      title="Dock"
      onclick={() => standaloneFiles.dock()}
    >
      <Minimize2 size={14} />
    </button>
    <button
      type="button"
      class="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={active ? `Close ${active.name}` : 'Close the file viewer'}
      title="Close the file viewer"
      onclick={() => {
        if (active) standaloneFiles.requestClose(active.path)
      }}
    >
      <X size={14} />
    </button>
  </div>

  <StandaloneFileTabs />

  {#if active}
    {#key active.path}
      <StandaloneFilePane path={active.path} name={active.name} />
    {/key}
  {/if}
</Modal>
