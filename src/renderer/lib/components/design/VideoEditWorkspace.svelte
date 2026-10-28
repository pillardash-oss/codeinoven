<script lang="ts">
  import { onMount, type Component, type Snippet } from 'svelte'
  import { on } from 'svelte/events'
  import { ContextMenu } from 'bits-ui'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import CioRedo from '@pdslng/cio-icon/CioRedo.svelte'
  import CioScissors from '@pdslng/cio-icon/CioScissors.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioClipboardPaste from '@pdslng/cio-icon/CioClipboardPaste.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import CioUpload from '@pdslng/cio-icon/CioUpload.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioSave from '@pdslng/cio-icon/CioSave.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import { appConfirm } from '$lib/stores/app-confirm.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { videoEditorController } from '$lib/stores/video-editor.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import VideoEditTimeline from './VideoEditTimeline.svelte'
  import VideoEditAssets from './VideoEditAssets.svelte'
  import VideoEditInspector from './VideoEditInspector.svelte'
  import StudioSidebarResizeHandle from '$lib/components/specs/StudioSidebarResizeHandle.svelte'

  interface Props {
    projectId: string
    threadId: string
    directory: string
    tabId: string
    active?: boolean
    onDirtyChange?: (dirty: boolean) => void
    onSaved?: () => void
    onExport: () => void
    mode?: 'embedded' | 'fullscreen'
    preview?: Snippet
    onMinimize?: () => void
    onExpand?: () => void
  }
  let {
    projectId,
    threadId,
    directory,
    tabId,
    active = true,
    onDirtyChange,
    onSaved,
    onExport,
    mode = 'embedded',
    preview,
    onMinimize,
    onExpand
  }: Props = $props()
  // The parent keys this component by project, thread and composition directory.
  // svelte-ignore state_referenced_locally
  const editor = videoEditorController(projectId, threadId, directory)
  let root: HTMLElement | undefined
  let section = $state<'inspector' | 'assets' | 'captions' | 'review'>('inspector')
  let leftWidth = $state(320)
  let upperHeight = $state(420)
  let assetsHeight = $state(180)
  let workspaceWidth = $state(1200)
  let workspaceHeight = $state(800)
  const shownUpperHeight = $derived(Math.min(upperHeight, Math.max(160, workspaceHeight - 220)))
  const shownLeftWidth = $derived(Math.min(leftWidth, Math.max(192, workspaceWidth - 320)))
  const shownAssetsHeight = $derived(Math.min(assetsHeight, Math.max(80, shownUpperHeight - 100)))
  const layoutKey = 'cio:video-editor-layout'
  function rememberLayout(): void {
    localStorage.setItem(layoutKey, JSON.stringify({ leftWidth, upperHeight, assetsHeight }))
  }
  onMount(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(layoutKey) ?? 'null')
      if (saved && typeof saved === 'object') {
        const layout = saved as Record<string, unknown>
        if (typeof layout.leftWidth === 'number' && Number.isFinite(layout.leftWidth))
          leftWidth = Math.max(192, layout.leftWidth)
        if (typeof layout.upperHeight === 'number' && Number.isFinite(layout.upperHeight))
          upperHeight = Math.max(160, layout.upperHeight)
        if (typeof layout.assetsHeight === 'number' && Number.isFinite(layout.assetsHeight))
          assetsHeight = Math.max(80, layout.assetsHeight)
      }
    } catch {
      /* A malformed preference falls back to usable panel sizes. */
    }
  })
  const sections = [
    { id: 'inspector', label: 'Inspector' },
    { id: 'assets', label: 'Assets' },
    { id: 'captions', label: 'Captions' },
    { id: 'review', label: 'Agent review' }
  ] as const
  const additions = [
    { id: 'video', label: 'Video track' },
    { id: 'audio', label: 'Audio track' },
    { id: 'overlay', label: 'Overlay track' }
  ] as const

  async function save(): Promise<void> {
    if (await editor.save()) onSaved?.()
  }
  async function exportMovie(): Promise<void> {
    if (!editor.dirty || (await editor.save())) onExport()
  }
  async function remove(
    ripple: boolean | 'all' = editor.rippleMode === 'all' ? 'all' : editor.rippleMode === 'track'
  ): Promise<void> {
    if (!editor.selection) return
    if (
      await appConfirm.request({
        title:
          ripple === 'all' && editor.selectedClip
            ? 'Ripple delete across all tracks?'
            : ripple && editor.selectedClip
              ? 'Ripple delete this clip?'
              : 'Remove the selected item?',
        body: [
          ripple === 'all' && editor.selectedClip
            ? 'This time range is removed across all unlocked tracks. Spanning clips split, and captions move with the edit. Locked tracks stay in place. Original media stays in assets.'
            : ripple && editor.selectedClip
              ? 'The clip is removed and later clips on the same track move left. Original media stays in assets.'
              : 'The selected timeline item is removed. Original media stays available, and Undo restores the item.'
        ],
        confirmLabel: 'Remove',
        cancelLabel: 'Cancel',
        tone: 'danger'
      })
    )
      editor.remove(ripple)
  }
  function add(value: (typeof additions)[number]['id']): void {
    if (value === 'video' || value === 'audio' || value === 'overlay') editor.addTrack(value)
  }
  function keydown(event: KeyboardEvent): void {
    if (!active || event.defaultPrevented || !(event.target instanceof Node)) return
    const fromPage = event.target === document
    if (
      !root?.contains(event.target) &&
      !fromPage &&
      !(mode === 'fullscreen' && event.target === document.body)
    )
      return
    if (keymapState.matches('video-primary-action', event)) {
      event.preventDefault()
      event.stopPropagation()
      if (editor.dirty) void save()
      else void exportMovie()
      return
    }
    const propertyInput =
      event.target instanceof HTMLInputElement &&
      ['number', 'range', 'color'].includes(event.target.type)
    const undo = keymapState.matches('video-edit-undo', event)
    const redo = keymapState.matches('video-edit-redo', event)
    if (propertyInput && (undo || redo)) {
      event.preventDefault()
      event.stopPropagation()
      // Number fields commit on change. Commit the focused draft before undoing it.
      if (event.target instanceof HTMLInputElement && event.target.type === 'number')
        event.target.dispatchEvent(new Event('change', { bubbles: true }))
      if (redo) editor.redo()
      else editor.undo()
      return
    }
    if (
      event.target instanceof HTMLElement &&
      (event.target.isContentEditable || event.target.closest('input,textarea,select'))
    )
      return
    const actions: [string, () => void][] = [
      ['video-edit-snap', () => (editor.snapEnabled = !editor.snapEnabled)],
      ['video-edit-paint-blur', () => void editor.paintBlur()],
      ['video-edit-undo', () => editor.undo()],
      ['video-edit-redo', () => editor.redo()],
      ['video-edit-split', () => editor.split()],
      ['video-edit-split-all', () => editor.split(true)],
      ['video-edit-duplicate', () => editor.duplicate()],
      ['video-edit-copy', () => editor.copy()],
      ['video-edit-paste', () => editor.paste()],
      [
        'video-edit-cut',
        () => {
          editor.copy()
          void remove()
        }
      ],
      [
        'video-edit-delete',
        () => {
          void remove()
        }
      ],
      [
        'video-edit-import',
        () => {
          void editor.importFiles()
        }
      ],
      [
        'video-edit-play',
        () => {
          void editor.togglePlayback()
        }
      ],
      ['video-edit-frame-back', () => editor.seek(editor.time - 1 / editor.fps)],
      ['video-edit-frame-forward', () => editor.seek(editor.time + 1 / editor.fps)]
    ]
    for (const [id, run] of actions)
      if (keymapState.matches(id, event)) {
        event.preventDefault()
        event.stopPropagation()
        run()
        return
      }
  }
</script>

{#snippet action(
  Icon: Component<{ size?: number }>,
  title: string,
  run: () => void,
  disabled = false,
  pressed?: boolean
)}
  <button
    type="button"
    class="titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
    {title}
    aria-label={title}
    {disabled}
    aria-pressed={pressed}
    onclick={run}><Icon size={13} /></button
  >
{/snippet}

{#snippet timelineTools()}
  <div class="w-56 min-w-40 shrink-0">
    <EnumSelect
      options={additions}
      value={null}
      placeholder="Add track"
      ariaLabel="Add track"
      title="Add a video, audio or overlay track"
      menuMinWidth="22rem"
      compact
      onChange={add}
    />
  </div>
  <label class="flex shrink-0 items-center gap-1 px-2 text-xs text-muted"
    ><Switch
      title="Snap clip edges"
      aria-label="Snap clip edges"
      checked={editor.snapEnabled}
      onchange={(value) => (editor.snapEnabled = value)}
    />Snap</label
  >
  <div class="w-40 shrink-0">
    <EnumSelect
      options={[
        { id: 'off', label: 'Ripple off' },
        { id: 'track', label: 'Ripple track' },
        { id: 'all', label: 'Ripple all tracks' }
      ]}
      value={editor.rippleMode}
      placeholder="Delete gaps"
      ariaLabel="Ripple delete mode"
      title="Choose whether deleting closes gaps on this track or all unlocked tracks"
      menuMinWidth="18rem"
      compact
      onChange={(value) => (editor.rippleMode = value)}
    />
  </div>
  {@render action(
    CioPencil,
    editor.selection?.kind === 'brush' ? 'Stop painting blur' : 'Paint blur on the preview',
    () => void editor.paintBlur(),
    false,
    editor.selection?.kind === 'brush'
  )}
  {#if editor.selection?.kind === 'brush'}<label class="flex items-center gap-1 text-xs text-muted"
      >Brush<input
        type="range"
        min="0.01"
        max="0.2"
        step="0.005"
        class="w-24"
        value={editor.selection.size}
        aria-label="Blur brush size"
        title="Blur brush size"
        oninput={(event) =>
          editor.select({ kind: 'brush', size: Number(event.currentTarget.value) })}
      /></label
    >{/if}
  {@render editActions()}
{/snippet}

{#snippet timelineContextActions()}
  <ContextMenu.Item
    class="cursor-pointer px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated data-disabled:opacity-30"
    disabled={!editor.selectedClip}
    onSelect={() => editor.copy()}>Copy clip</ContextMenu.Item
  >
  <ContextMenu.Item
    class="cursor-pointer px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated data-disabled:opacity-30"
    disabled={!editor.canPaste}
    onSelect={() => editor.paste()}>Paste clip at playhead</ContextMenu.Item
  >
  <ContextMenu.Item
    class="cursor-pointer px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated data-disabled:opacity-30"
    disabled={!editor.selectedClip}
    onSelect={() => {
      editor.copy()
      void remove()
    }}>Cut clip</ContextMenu.Item
  >
  {#each [{ label: 'Undo', run: () => editor.undo(), disabled: !editor.canUndo }, { label: 'Redo', run: () => editor.redo(), disabled: !editor.canRedo }, { label: 'Split at playhead', run: () => editor.split(), disabled: !editor.selectedClip }, { label: 'Split all unlocked tracks', run: () => editor.split(true), disabled: !editor.edit }, { label: 'Duplicate selected item', run: () => editor.duplicate(), disabled: !editor.selection }, { label: 'Remove selected item', run: () => {
        void remove()
      }, disabled: !editor.selection }, { label: 'Ripple delete clip', run: () => {
        void remove(true)
      }, disabled: !editor.selectedClip }, { label: 'Import media', run: () => {
        void editor.importFiles()
      }, disabled: editor.importing }] as item (item.label)}
    <ContextMenu.Item
      class="cursor-pointer px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated data-disabled:opacity-30"
      disabled={item.disabled}
      onSelect={item.run}>{item.label}</ContextMenu.Item
    >
  {/each}
{/snippet}

{#snippet editActions()}
  {@render action(CioCopy, 'Copy the selected clip', () => editor.copy(), !editor.selectedClip)}
  {@render action(
    CioClipboardPaste,
    'Paste clip at the playhead',
    () => editor.paste(),
    !editor.canPaste
  )}
  {@render action(
    CioUndo,
    `Undo (${keymapState.labelFor('video-edit-undo')})`,
    () => editor.undo(),
    !editor.canUndo
  )}
  {@render action(
    CioRedo,
    `Redo (${keymapState.labelFor('video-edit-redo')})`,
    () => editor.redo(),
    !editor.canRedo
  )}
  {@render action(
    CioScissors,
    `Split clip at playhead (${keymapState.labelFor('video-edit-split')})`,
    () => editor.split(),
    !editor.selectedClip
  )}
  {@render action(
    CioCopy,
    'Duplicate the selected item',
    () => editor.duplicate(),
    !editor.selection
  )}
  {@render action(
    CioTrash,
    'Remove the selected timeline item',
    () => {
      void remove()
    },
    !editor.selection
  )}
  {@render action(
    CioUpload,
    'Import media and stickers into assets',
    () => {
      void editor.importFiles()
    },
    editor.importing || editor.saving
  )}
{/snippet}

<section
  {@attach (element) => {
    root = element
    const releaseKeys = on(window, 'keydown', keydown, { capture: true })
    const observer = new ResizeObserver(() => {
      workspaceWidth = element.clientWidth
      workspaceHeight = element.clientHeight
    })
    observer.observe(element)
    const release = editor.attach(tabId, active, onDirtyChange)
    return () => {
      if (root === element) root = undefined
      releaseKeys()
      observer.disconnect()
      release()
    }
  }}
  class="flex h-full min-h-0 flex-col overflow-hidden bg-app"
  aria-label="Video editor"
  data-drop-region="video-editor"
>
  <div
    class={[
      'flex shrink-0 items-center gap-2 border-b border-border bg-surface px-2',
      mode === 'fullscreen' ? 'titlebar-drag h-10' : 'h-9'
    ]}
    style={mode === 'fullscreen' ? trafficLightInsetStyle() : undefined}
  >
    {#if mode === 'fullscreen'}<div class="titlebar-no-drag w-36 shrink-0">
        <EnumSelect
          options={mode === 'fullscreen'
            ? sections.filter((item) => item.id !== 'assets')
            : sections}
          value={section}
          placeholder="Inspector"
          ariaLabel="Editor section"
          title="Inspector, local assets or captions"
          menuMinWidth="20rem"
          compact
          onChange={(value) => (section = value)}
        />
      </div>{:else}<button
        type="button"
        class="titlebar-no-drag flex h-7 items-center gap-2 text-xs text-foreground hover:text-primary"
        title="Open the full video editor"
        aria-label="Open Editor"
        onclick={onExpand}><CioMaximize size={13} />Open Editor</button
      >{/if}
    <div class="min-w-0 flex-1"></div>
    {@render action(
      CioDownload,
      'Export this composition as MP4',
      () => {
        void exportMovie()
      },
      editor.loading || editor.saving || !editor.document
    )}
    <button
      type="button"
      class="titlebar-no-drag ml-1 flex h-7 w-7 shrink-0 items-center justify-center bg-primary text-on-primary hover:opacity-90 disabled:opacity-30"
      title={`Save the composition (${keymapState.labelFor('video-primary-action')})`}
      aria-label="Save the composition"
      disabled={!editor.dirty || editor.saving}
      onclick={() => void save()}
    >
      {#if editor.saving}<CioSpinner size={12} class="animate-spin" />{:else}<CioSave
          size={12}
        />{/if}
    </button>
    {#if mode === 'fullscreen' && onMinimize}{@render action(
        CioMinimize,
        'Return to the docked video editor',
        onMinimize
      )}{/if}
  </div>
  {#if editor.error}<p
      class="shrink-0 border-b border-danger/30 bg-danger/10 px-2 py-1 text-[0.6875rem] text-danger"
      role="alert"
    >
      {editor.error}
    </p>{/if}
  {#if editor.externalChange}
    <div
      class="flex shrink-0 items-center justify-between gap-2 border-b border-warning/30 px-2 py-1 text-[0.6875rem] text-warning"
    >
      <span>The agent saved another revision. Your draft is kept.</span><button
        type="button"
        class="shrink-0 underline"
        title="Reload the saved revision after deciding what to keep"
        onclick={async () => {
          if (
            await appConfirm.request({
              title: 'Reload the saved edit?',
              body: ['Your unsaved timeline changes will be replaced by the saved revision.'],
              confirmLabel: 'Reload',
              tone: 'danger'
            })
          )
            await editor.load(false)
        }}>Reload</button
      >
    </div>
  {/if}
  {#if editor.loading}<div
      class="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted"
    >
      <CioSpinner size={14} class="animate-spin" />Loading editable tracks…
    </div>
  {:else if editor.edit}
    {#if mode === 'fullscreen'}
      <div
        class="grid min-h-40 shrink-0"
        style:height={`${shownUpperHeight}px`}
        style:grid-template-columns={`${shownLeftWidth}px 0.375rem minmax(0,1fr)`}
      >
        <aside class="flex min-h-0 min-w-0 flex-col bg-surface" aria-label="Media and inspector">
          <div class="min-h-20 shrink-0" style:height={`${shownAssetsHeight}px`}>
            <VideoEditAssets {editor} expanded />
          </div>
          <StudioSidebarResizeHandle
            sidebarLabel="asset bin and inspector"
            axis="y"
            value={shownAssetsHeight}
            min={80}
            max={Math.max(80, shownUpperHeight - 100)}
            onResize={(value) => (assetsHeight = value)}
            onCommit={rememberLayout}
            class="h-1.5 w-full shrink-0 cursor-row-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
          />
          <div class="min-h-0 flex-1">
            {#if section === 'review'}
              <div class="h-full overflow-y-auto p-2 text-xs" aria-label="Agent edit review">
                {#each editor.edit.changes
                  .filter((change) => change.author === 'agent')
                  .slice(-200)
                  .reverse() as change (change.id)}
                  <div class="flex items-center justify-between gap-2 border-b border-border py-2">
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left text-muted hover:text-foreground"
                      title="Seek to this agent edit"
                      onclick={() => editor.seek(change.start)}>{change.label}</button
                    >
                    <button
                      type="button"
                      class="shrink-0 text-primary disabled:text-dimmed"
                      title={change.reviewed
                        ? 'Agent edit reviewed'
                        : 'Mark this agent edit reviewed'}
                      disabled={change.reviewed}
                      onclick={() =>
                        editor.mutate((_doc, edit) => {
                          const target = edit.changes.find((item) => item.id === change.id)
                          if (target) target.reviewed = true
                        })}>{change.reviewed ? 'Reviewed' : 'Mark reviewed'}</button
                    >
                  </div>
                {:else}<p class="text-muted">No agent edits recorded yet.</p>{/each}
              </div>
            {:else}<VideoEditInspector {editor} expanded captions={section === 'captions'} />{/if}
          </div>
        </aside>
        <StudioSidebarResizeHandle
          sidebarLabel="left editor panel"
          value={shownLeftWidth}
          min={192}
          max={Math.max(192, workspaceWidth - 320)}
          onResize={(value) => (leftWidth = value)}
          onCommit={rememberLayout}
          class="h-full w-1.5 cursor-col-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
        />
        <div class="flex min-h-0 min-w-0 flex-col bg-app" aria-label="Video preview">
          {@render preview?.()}
        </div>
      </div>
      <StudioSidebarResizeHandle
        sidebarLabel="preview and timeline"
        axis="y"
        value={shownUpperHeight}
        min={160}
        max={Math.max(160, workspaceHeight - 200)}
        onResize={(value) => (upperHeight = value)}
        onCommit={rememberLayout}
        class="h-1.5 w-full shrink-0 cursor-row-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
      />
      <div class="flex min-h-32 flex-1 flex-col">
        <VideoEditTimeline {editor} tools={timelineTools} contextActions={timelineContextActions} />
      </div>
    {/if}
  {:else}<div class="p-3 text-xs text-muted">
      Open or import a composition to start editing.
    </div>{/if}
</section>
