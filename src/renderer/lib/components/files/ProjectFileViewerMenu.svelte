<script lang="ts">
  import Switch from '$lib/components/ui/Switch.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import CioBraces from '@pdslng/cio-icon/CioBraces.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioFind from '@pdslng/cio-icon/CioFind.svelte'
  import CioListOrdered from '@pdslng/cio-icon/CioListOrdered.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioRedo from '@pdslng/cio-icon/CioRedo.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioReplace from '@pdslng/cio-icon/CioReplace.svelte'
  import CioTabInfo from '@pdslng/cio-icon/CioTabInfo.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import CioWrapText from '@pdslng/cio-icon/CioWrapText.svelte'
  import { DropdownMenu } from 'bits-ui'
  interface Props {
    ideModeEnabled: boolean
    ideModeDisabled: boolean
    onIdeModeChange: (enabled: boolean) => void
    diffView: boolean
    lineNumbers: boolean
    wrap: boolean
    reloadDisabled: boolean
    mutationDisabled: boolean
    /** Show undo/redo buttons ahead of the menu; only the file editor
     *  (editable source view) sets this. */
    showUndoRedo?: boolean
    /** Whether the editor behind this menu still holds history in that
     *  direction; a button whose action would do nothing is disabled. */
    canUndo?: boolean
    canRedo?: boolean
    /** Open the same File info dialog the file tree's context menu shows for
     *  the active file. Disabled (greyed out) while infoDisabled is set. */
    onInfo: () => void
    /** File info reads the file from disk, so it is unavailable for files that
     *  no longer exist on disk (deleted at checkpoint). */
    infoDisabled?: boolean
    /** Format label the active file can be beautified as ("JSON"), or null when
     *  the editor cannot reformat it. Drives the menu item and, in fullscreen,
     *  the toolbar button beside the fullscreen controls. */
    beautifyLabel?: string | null
    /** The viewer already fills the window, so it no longer offers fullscreen. */
    fullscreen?: boolean
    /** Whether the viewer can search what it is showing. */
    findDisabled?: boolean
    /** Replace needs a draft, so only the source editor offers it. */
    replaceDisabled?: boolean
    onSearch: () => void
    onSearchReplace: () => void
    onUndo: () => void
    onRedo: () => void
    onReload: () => void
    onToggleLineNumbers: () => void
    onToggleWrap: () => void
    onBeautify: () => void
    onFullscreen: () => void
    onRename: () => void
    onDelete: () => void
  }

  let {
    ideModeEnabled,
    ideModeDisabled,
    onIdeModeChange,
    diffView,
    lineNumbers,
    wrap,
    reloadDisabled,
    mutationDisabled,
    showUndoRedo = false,
    canUndo = false,
    canRedo = false,
    beautifyLabel = null,
    fullscreen = false,
    findDisabled = false,
    replaceDisabled = false,
    onSearch,
    onSearchReplace,
    onInfo,
    infoDisabled = false,
    onUndo,
    onRedo,
    onReload,
    onToggleLineNumbers,
    onToggleWrap,
    onBeautify,
    onFullscreen,
    onRename,
    onDelete
  }: Props = $props()

  const itemClass =
    'flex items-center gap-2 px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'

  const btnClass =
    'flex h-6 w-6 items-center justify-center text-dimmed transition-colors enabled:hover:bg-elevated enabled:hover:text-foreground disabled:opacity-30'

  let open = $state(false)
</script>

{#if showUndoRedo}
  <button
    type="button"
    class={btnClass}
    aria-label={`Undo (${keymapState.labelFor('editor-undo')})`}
    title={`Undo (${keymapState.labelFor('editor-undo')})`}
    disabled={!canUndo}
    onclick={onUndo}
  >
    <CioUndo size={13} />
  </button>
  <button
    type="button"
    class={btnClass}
    aria-label={`Redo (${keymapState.labelFor('editor-redo')})`}
    title={`Redo (${keymapState.labelFor('editor-redo')})`}
    disabled={!canRedo}
    onclick={onRedo}
  >
    <CioRedo size={13} />
  </button>
{/if}
{#if fullscreen && beautifyLabel}
  <button
    type="button"
    class={btnClass}
    aria-label={`Beautify ${beautifyLabel}`}
    title={`Beautify ${beautifyLabel}`}
    onclick={onBeautify}
  >
    <CioBraces size={13} />
  </button>
{/if}
{#if !fullscreen}
  <button
    type="button"
    class={btnClass}
    aria-label="View fullscreen"
    title="Fullscreen"
    onclick={onFullscreen}
  >
    <CioMaximize size={13} />
  </button>
{/if}
<!--
  The menu is offered in every view, including a diff: the search commands are
  the reason, since a rendered document or a diff is exactly what a reader wants
  to search. The editor toggles below it are the ones a diff has no use for, so
  they grey out instead of the menu disappearing.
-->
<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger
    class={btnClass}
    aria-label="File viewer actions"
    title="File viewer actions"
    oncontextmenu={(e: MouseEvent) => {
      e.preventDefault()
      open = true
    }}
  >
    <CioEllipsis size={13} />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={5}
      avoidCollisions
      collisionPadding={10}
      class="z-90 min-w-52 border border-border bg-surface p-1 shadow-lg"
    >
      <div class="px-2.5 py-2">
        <Switch
          checked={ideModeEnabled}
          disabled={ideModeDisabled}
          onchange={onIdeModeChange}
          label="IDE Mode"
          aria-label="IDE Mode"
          title="Enable search and language navigation for this project tree"
        />
      </div>
      <DropdownMenu.Separator class="my-1 h-px bg-border" />
      <DropdownMenu.Item
        class={itemClass}
        disabled={findDisabled}
        title={findDisabled
          ? 'This surface cannot be searched from the reader'
          : `Search ${keymapState.labelFor('nav-find')}`}
        onSelect={onSearch}
      >
        <CioFind size={13} class="text-muted" />
        <span class="flex-1">Search</span>
        <span class="text-[0.625rem] text-dimmed">{keymapState.labelFor('nav-find')}</span>
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class={itemClass}
        disabled={replaceDisabled}
        title={replaceDisabled ? 'Replace works in the source view' : undefined}
        onSelect={onSearchReplace}
      >
        <CioReplace size={13} class="text-muted" />
        Search and replace
      </DropdownMenu.Item>
      <DropdownMenu.Separator class="my-1 h-px bg-border" />
      <DropdownMenu.Item class={itemClass} disabled={reloadDisabled} onSelect={onReload}>
        <CioRefresh size={13} class="text-muted" />
        Reload file
      </DropdownMenu.Item>
      <DropdownMenu.Item class={itemClass} disabled={diffView} onSelect={onToggleLineNumbers}>
        <CioListOrdered size={13} class="text-muted" />
        <span class="flex-1">{lineNumbers ? 'Hide line numbers' : 'Show line numbers'}</span>
        {#if lineNumbers}
          <CioCheck size={12} class="text-primary" />
        {/if}
      </DropdownMenu.Item>
      <DropdownMenu.Item class={itemClass} disabled={diffView} onSelect={onToggleWrap}>
        <CioWrapText size={13} class="text-muted" />
        <span class="flex-1">Wrap</span>
        {#if wrap}
          <CioCheck size={12} class="text-primary" />
        {/if}
      </DropdownMenu.Item>
      {#if beautifyLabel}
        <DropdownMenu.Item class={itemClass} disabled={diffView} onSelect={onBeautify}>
          <CioBraces size={13} class="text-muted" />
          Beautify {beautifyLabel}
        </DropdownMenu.Item>
      {/if}
      <DropdownMenu.Item class={itemClass} disabled={infoDisabled} onSelect={onInfo}>
        <CioTabInfo size={13} class="text-muted" />
        File info
      </DropdownMenu.Item>
      <DropdownMenu.Separator class="my-1 h-px bg-border" />
      <DropdownMenu.Item class={itemClass} disabled={mutationDisabled} onSelect={onRename}>
        <CioPencil size={13} class="text-muted" />
        Rename
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="{itemClass} text-danger data-[highlighted]:bg-danger/10"
        disabled={mutationDisabled}
        onSelect={onDelete}
      >
        <CioTrash size={13} />
        Delete
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
