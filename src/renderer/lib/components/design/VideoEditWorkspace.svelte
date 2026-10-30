<script lang="ts">
  import { onMount, type Component, type Snippet } from 'svelte'
  import { on } from 'svelte/events'
  import { ContextMenu } from 'bits-ui'
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioAudioLines from '@pdslng/cio-icon/CioAudioLines.svelte'
  import CioCaptions from '@pdslng/cio-icon/CioCaptions.svelte'
  import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
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
  import ShortcutHint from '$lib/components/ui/ShortcutHint.svelte'
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
    { id: 'video', label: 'Video', icon: CioClapper },
    { id: 'audio', label: 'Audio', icon: CioAudioLines },
    { id: 'caption', label: 'Captions', icon: CioCaptions },
    { id: 'overlay', label: 'Overlays', icon: CioLayers }
  ] as const

  async function save(): Promise<void> {
    if (await editor.save()) onSaved?.()
  }
  async function exportMovie(): Promise<void> {
    if (!editor.dirty || (await editor.save())) onExport()
  }
  async function remove(ripple: boolean | 'all' = editor.magneticDeleteMode): Promise<void> {
    if (!editor.selection) return
    const count = editor.selectedIds.size
    if (count > 1) {
      if (
        await appConfirm.request({
          title: `Remove ${count} selected clips?`,
          body: [
            'The clips are removed from the timeline and leave their gaps behind. Original media stays in assets, and Undo restores the whole group.'
          ],
          confirmLabel: 'Remove',
          cancelLabel: 'Cancel',
          tone: 'danger'
        })
      )
        editor.remove(false)
      return
    }
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
    if (value === 'video' || value === 'audio' || value === 'caption' || value === 'overlay')
      editor.addTrack(value)
  }
  /** One row of the timeline context menu. */
  interface TimelineMenuRow {
    label: string
    /** The keymap id this row teaches, so its binding is whatever the registry
     *  and the user's overrides resolve to. */
    id: string
    run: () => void
    disabled: boolean
  }
  /**
   * Timeline context menu, grouped the way the editor's actions relate. Every
   * row shows its own binding from the live keymap, so the menu teaches the
   * shortcuts as the user works and follows any rebinding. An unbound id shows
   * no hint rather than a guess, and binding it later needs no code change.
   */
  function timelineMenuRows(): (TimelineMenuRow & { keys: readonly string[] })[][] {
    const groups: TimelineMenuRow[][] = [
      [
        {
          label: 'Snap all on track',
          id: 'video-edit-snap-all',
          run: () => editor.snapClips(),
          disabled: !editor.canSnapClips
        },
        {
          label: 'Merge selected clips',
          id: 'video-edit-merge-selected',
          run: () => editor.mergeClips(),
          disabled: !editor.canMergeClips
        },
        {
          label: 'Merge all on track',
          id: 'video-edit-merge-all',
          run: () => editor.mergeClips(true),
          disabled: !editor.selectedClip
        }
      ],
      [
        {
          label: 'Select all on track',
          id: 'video-edit-select-all',
          run: () => editor.selectAllOnTrack(),
          disabled: !editor.edit
        },
        {
          label: 'Extract audio',
          id: 'video-edit-extract-audio',
          run: () => editor.extractAudio(),
          disabled: !editor.canExtractAudio
        }
      ],
      [
        {
          label: 'Undo',
          id: 'video-edit-undo',
          run: () => editor.undo(),
          disabled: !editor.canUndo
        },
        {
          label: 'Redo',
          id: 'video-edit-redo',
          run: () => editor.redo(),
          disabled: !editor.canRedo
        },
        {
          label: 'Split at playhead',
          id: 'video-edit-split',
          run: () => editor.split(),
          disabled: !editor.selectedClip
        },
        {
          label: 'Split all unlocked tracks',
          id: 'video-edit-split-all',
          run: () => editor.split(true),
          disabled: !editor.edit
        },
        {
          label: 'Duplicate selected item',
          id: 'video-edit-duplicate',
          run: () => editor.duplicate(),
          disabled: !editor.selection
        }
      ],
      [
        {
          label: 'Copy clip',
          id: 'video-edit-copy',
          run: () => editor.copy(),
          disabled: !editor.selectedClip
        },
        {
          label: 'Paste clip at playhead',
          id: 'video-edit-paste',
          run: () => editor.paste(),
          disabled: !editor.canPaste
        },
        {
          label: 'Cut clip',
          id: 'video-edit-cut',
          run: () => {
            editor.copy()
            void remove()
          },
          disabled: !editor.selectedClip
        },
        {
          label: 'Remove selected item',
          id: 'video-edit-delete',
          run: () => {
            void remove()
          },
          disabled: !editor.selection
        }
      ],
      [
        {
          label: 'Import media',
          id: 'video-edit-import',
          run: () => {
            void editor.importFiles()
          },
          disabled: editor.importing
        }
      ]
    ]
    return groups.map((group) =>
      group.map((item) => ({ ...item, keys: keymapState.keysFor(item.id) }))
    )
  }
  const timelineMenu = $derived(timelineMenuRows())

  /**
   * Whether the event came from a field that is having text typed into it.
   *
   * A field owns its modifier shortcuts: the comment written on a frame saves with
   * the same mod+Enter this workspace saves and exports with, and a comment must
   * never export a movie. Numeric, range and colour inputs are excluded because
   * their undo and redo belong to the workspace rather than to the field.
   */
  function typingInTextEntry(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    if (target.isContentEditable) return true
    if (target.closest('textarea,[data-floating-document]')) return true
    const input = target.closest('input')
    return input instanceof HTMLInputElement && !['number', 'range', 'color'].includes(input.type)
  }

  /**
   * Whether a pen is open on a picture over this editor.
   *
   * The pen owns Escape and its own comment fields, so while it is armed the editor
   * stands aside for those keys rather than competing with the surface in front of
   * it. The play/pause key is not one of them: a space beside an annotated frame
   * plays and pauses the picture the pen is drawing on, and the pen stays in hand.
   */
  function penOwnsKeyboard(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && target.closest('[data-annotation-surface]') !== null
  }

  /**
   * Whether a control answers a space by itself.
   *
   * A `select` opens its list on a space, so that press is the control's. A button
   * or a seek track does nothing useful with it: in this editor space is the
   * play/pause key wherever the focus is.
   */
  function controlOwnsSpace(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && target.closest('select') !== null
  }

  /**
   * Whether a press belongs to this editor.
   *
   * The editor's own tree, the page it is drawn in, and — full screen — the modal it
   * is drawn in. A full screen surface is a modal that focuses its own panel rather
   * than a control, so a press on that panel is a press in the editor; a dialog
   * elsewhere on screen is not, and neither is a field in front of it.
   */
  function ownsTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false
    if (root?.contains(target)) return true
    if (target === document) return true
    if (mode !== 'fullscreen') return false
    if (target === document.body) return true
    const element = target instanceof HTMLElement ? target : null
    const modal = element?.closest('[aria-modal="true"]') ?? null
    return modal !== null && root !== undefined && modal.contains(root)
  }

  function keydown(event: KeyboardEvent): void {
    if (!active || event.defaultPrevented) return
    if (!ownsTarget(event.target)) return
    // The keys of a field in front of the editor are the field's, and this runs in
    // the capture phase, before the field itself answers them. A space typed into a
    // comment or a track name is a space.
    if (typingInTextEntry(event.target)) return
    // Play/pause is the one key that fires wherever the focus is inside the editor:
    // on a clip, on the seek track, on a toolbar button, on a frame the pen is
    // drawing on. It is answered before the pen and the controls below are given
    // their own keys, because none of them do anything useful with a space and the
    // pen's own continue key is not this one.
    if (!controlOwnsSpace(event.target) && keymapState.matches('video-edit-play', event)) {
      event.preventDefault()
      event.stopPropagation()
      // A held key is one press: repeating it would flip play and pause at the
      // keyboard's repeat rate.
      if (!event.repeat) void editor.togglePlayback()
      return
    }
    // The pen in front of a frame claims the rest of its own keys.
    if (penOwnsKeyboard(event.target)) return
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
      ['video-edit-select-all', () => editor.selectAllOnTrack()],
      ['video-edit-snap-all', () => editor.snapClips()],
      ['video-edit-merge-selected', () => editor.mergeClips()],
      ['video-edit-merge-all', () => editor.mergeClips(true)],
      ['video-edit-paint-blur', () => void editor.paintBlur()],
      ['video-edit-undo', () => editor.undo()],
      ['video-edit-redo', () => editor.redo()],
      ['video-edit-split', () => editor.split()],
      ['video-edit-split-all', () => editor.split(true)],
      ['video-edit-duplicate', () => editor.duplicate()],
      ['video-edit-extract-audio', () => editor.extractAudio()],
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
      title="Magnetic timeline: move following clips together and close gaps on delete"
      aria-label="Magnetic timeline"
      checked={editor.snapEnabled}
      onchange={(value) => (editor.snapEnabled = value)}
    />Snap</label
  >
  <div class="w-40 shrink-0">
    <EnumSelect
      options={[
        { id: 'all', label: 'All tracks' },
        { id: 'track', label: 'This track' }
      ]}
      value={editor.magneticScope}
      placeholder="Magnetic scope"
      ariaLabel="Magnetic editing scope"
      title="Apply magnetic dragging, trimming and deletion to this track or all unlocked tracks"
      menuMinWidth="18rem"
      compact
      disabled={!editor.snapEnabled}
      onChange={(value) => (editor.magneticScope = value)}
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
  {#each timelineMenu as group, groupIndex (groupIndex)}
    {#if groupIndex > 0}<ContextMenu.Separator class="my-1 h-px bg-border" />{/if}
    {#each group as item (item.label)}
      <ContextMenu.Item
        class="flex cursor-pointer items-center justify-between gap-6 px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated data-disabled:opacity-30"
        disabled={item.disabled}
        onSelect={() => item.run()}
      >
        <span class="flex-1">{item.label}</span>
        {#if item.keys.length > 0}<ShortcutHint keys={item.keys} />{/if}
      </ContextMenu.Item>
    {/each}
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
    CioDownload,
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
  data-video-chrome
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
    {#if mode === 'fullscreen'}<div class="titlebar-no-drag flex w-64 shrink-0 items-center gap-2">
        <!--
          The surface names itself, and the picker beside it names the section.

          The picker shows the open section as its value, so a header that held only
          the picker read as though the panel were called "Inspector": the title is
          the surface, and the picker is what changes inside it.
        -->
        <span class="shrink-0 text-xs font-medium text-foreground">Video editor</span>
        <div class="min-w-0 flex-1">
          <EnumSelect
            options={sections.filter((item) => item.id !== 'assets')}
            value={section}
            placeholder="Inspector"
            ariaLabel="Editor section"
            title="Inspector, local assets or captions"
            menuMinWidth="20rem"
            compact
            onChange={(value) => (section = value)}
          />
        </div>
      </div>{:else}<button
        type="button"
        class="titlebar-no-drag flex h-7 items-center gap-2 text-xs text-foreground hover:text-primary"
        title="Open the full video editor"
        aria-label="Open Editor"
        onclick={onExpand}><CioMaximize size={13} />Open Editor</button
      >{/if}
    <div class="min-w-0 flex-1"></div>
    {@render action(
      CioUpload,
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
