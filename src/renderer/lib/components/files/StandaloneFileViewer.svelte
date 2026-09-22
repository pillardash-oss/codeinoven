<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { X } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import StandaloneFilePane from './StandaloneFilePane.svelte'

  /**
   * Fullscreen viewer/editor for files opened through the operating system
   * ("Open in CodeInOven").
   *
   * It is intentionally project-less: with no project there is no file tree, no
   * tree operations, and no directory index to read or hold in memory   only
   * the single file on screen. Text and code are editable and saved straight
   * back to the file they came from; the preview modes mirror the project editor,
   * so every file type the editor can preview previews here too.
   */
  const active = $derived(standaloneFiles.active)
  const open = $derived(standaloneFiles.open)

  /** A file whose close is waiting on the unsaved-changes decision. */
  let pendingClose = $state<{ path: string; name: string } | null>(null)

  // The browser renders a native `WebContentsView` that the compositor paints
  // above every DOM surface, so this full-window viewer must publish itself as a
  // fullscreen surface while it is up, exactly like the project's own
  // fullscreen file editor. Without this the still-attached browser view covers
  // the editor and its toolbar. Keyed distinctly from that editor so the two
  // overlapping surfaces never clear each other's registration, and cleared on
  // destroy so an unmount can never leave the view permanently suppressed.
  $effect(() => browserVisibility.hideWhile('standalone-file-viewer', 'fullscreen-surface', open))

  /** Close a file, asking first when it has edits that are not on disk yet. */
  function requestClose(path: string): void {
    if (!standaloneFiles.isDirty(path)) {
      standaloneFiles.close(path)
      return
    }
    const file = standaloneFiles.files.find((candidate) => candidate.path === path)
    if (file) pendingClose = { path: file.path, name: file.name }
  }

  /** Save the pending file and close it; on failure the tab stays open so the
   *  error the pane renders can be acted on. */
  async function saveAndClosePending(): Promise<void> {
    const target = pendingClose
    if (!target) return
    const session = standaloneFiles.session(target.path)
    // A save already in flight: let it land rather than closing over it.
    if (session?.saving) return
    await standaloneFiles.save(target.path)
    if (standaloneFiles.isDirty(target.path)) {
      pendingClose = null
      toast.error(`${target.name} could not be saved`, {
        description: 'The file stayed open so you can review the error and retry.'
      })
      return
    }
    standaloneFiles.close(target.path)
    pendingClose = null
  }

  function discardPending(): void {
    const target = pendingClose
    if (!target) return
    standaloneFiles.close(target.path)
    pendingClose = null
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(next: boolean) => {
    if (!next && active) requestClose(active.path)
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-app shadow-xl outline-none"
    >
      <div
        class="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3"
        style={trafficLightInsetStyle()}
      >
        <Dialog.Title class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {active?.name ?? 'File'}
        </Dialog.Title>
        <Dialog.Description class="sr-only">
          File opened on its own, without a project or file tree. Text is editable and saves
          straight back to the file.
        </Dialog.Description>
        <Dialog.Close
          class="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={active ? `Close ${active.name}` : 'Close the file viewer'}
          title="Close the file viewer"
        >
          <X size={14} />
        </Dialog.Close>
      </div>

      {#if standaloneFiles.files.length > 1}
        <!-- One file is the common case (and needs no strip); several files
             arriving at once stay reachable without leaving the viewer. -->
        <div
          class="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2"
          role="tablist"
          aria-label="Open files"
        >
          {#each standaloneFiles.files as file (file.path)}
            <button
              type="button"
              role="tab"
              class={[
                'flex h-5 max-w-52 shrink-0 items-center gap-1.5 rounded px-2 text-[0.625rem] transition-colors',
                file.path === standaloneFiles.activePath
                  ? 'bg-overlay text-foreground'
                  : 'text-dimmed hover:bg-elevated hover:text-foreground'
              ]}
              aria-selected={file.path === standaloneFiles.activePath}
              title={file.path}
              onclick={() => standaloneFiles.activate(file.path)}
            >
              {#if standaloneFiles.isDirty(file.path)}
                <span
                  class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  role="status"
                  aria-label="Unsaved changes"
                  title="Unsaved changes"
                ></span>
              {/if}
              <span class="truncate">{file.name}</span>
            </button>
            <button
              type="button"
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              aria-label={`Close ${file.name}`}
              title={`Close ${file.name}`}
              onclick={() => requestClose(file.path)}
            >
              <X size={11} />
            </button>
          {/each}
        </div>
      {/if}

      {#if active}
        {#key active.path}
          <StandaloneFilePane path={active.path} name={active.name} />
        {/key}
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<ConfirmDialog
  open={pendingClose !== null}
  title="Unsaved changes"
  onCancel={() => (pendingClose = null)}
  onConfirm={saveAndClosePending}
  confirmLabel="Save and close"
  variant="primary"
  secondaryAction={{ label: 'Discard', onSelect: discardPending, tone: 'danger' }}
>
  <p>
    <span class="font-medium text-foreground">{pendingClose?.name}</span> has edits that are not saved
    to disk yet.
  </p>
</ConfirmDialog>
