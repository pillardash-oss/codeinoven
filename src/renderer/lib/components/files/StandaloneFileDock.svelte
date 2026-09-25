<script lang="ts">
  import { Maximize2, FileCode2 } from '@lucide/svelte'

  import { APP_SLUG } from '$shared/brand'
  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import StandaloneFilePane from './StandaloneFilePane.svelte'
  import StandaloneFileTabs from './StandaloneFileTabs.svelte'

  /**
   * Files opened through the operating system, docked as a floating panel so the
   * workspace and its threads stay usable while the file stays open. Minimizing
   * leaves a chip at a screen edge; the panel is kept mounted so the editor, its
   * draft and its undo history survive the collapse. The fullscreen reader/editor
   * is one action away (`showFullscreen`), and the panel is deliberately not
   * closable: Escape and Cmd/Ctrl+W collapse it into the chip rather than
   * dropping the file, and files close through the tab strip.
   */
  const storageKey = `${APP_SLUG}.standaloneFiles.v1`

  const active = $derived(standaloneFiles.active)
  const fileCount = $derived(standaloneFiles.files.length)
  const activeDirty = $derived(active ? standaloneFiles.isDirty(active.path) : false)
</script>

<DockableModal
  open={standaloneFiles.open}
  title={active?.name ?? 'File'}
  minimized={standaloneFiles.minimized}
  closable={false}
  onMinimize={() => standaloneFiles.minimize()}
  onClose={() => standaloneFiles.minimize()}
  flushBody
  {storageKey}
  dragLabel="Drag to move this file"
  defaultHeight={520}
>
  {#snippet headerActions()}
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Open this file full screen"
      title="Full screen"
      onclick={() => standaloneFiles.showFullscreen()}
    >
      <Maximize2 size={14} />
    </button>
  {/snippet}

  {#snippet dock()}
    <DockRow {storageKey} label="Move docked files">
      <div class="flex items-center gap-1 rounded-xl border bg-surface p-1.5 shadow-xl">
        <button
          type="button"
          class="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
          aria-label={`Show ${active?.name ?? 'the file'}`}
          title={active?.path ?? 'Show the file'}
          onclick={() => standaloneFiles.restore()}
        >
          <FileCode2 size={14} class="shrink-0 text-dimmed" aria-hidden="true" />
          <span class="flex min-w-0 flex-col">
            <span
              class="max-w-40 truncate text-[0.625rem] font-medium leading-tight text-foreground"
              >{active?.name ?? 'File'}</span
            >
            {#if fileCount > 1}
              <span class="text-[0.5625rem] leading-tight text-muted">{fileCount} files open</span>
            {/if}
          </span>
          {#if activeDirty}
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
              role="status"
              aria-label="Unsaved changes"
              title="Unsaved changes"
            ></span>
          {/if}
        </button>
      </div>
    </DockRow>
  {/snippet}

  {#if active}
    <div class="flex min-h-0 flex-1 flex-col">
      <StandaloneFileTabs />
      {#key active.path}
        <StandaloneFilePane
          path={active.path}
          name={active.name}
          saveShortcutEnabled={!standaloneFiles.minimized}
        />
      {/key}
    </div>
  {/if}
</DockableModal>
