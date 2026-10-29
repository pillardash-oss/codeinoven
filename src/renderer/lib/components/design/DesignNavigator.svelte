<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioFolderPlus from '@pdslng/cio-icon/CioFolderPlus.svelte'
  import CioGrip from '@pdslng/cio-icon/CioGrip.svelte'
  import CioImageOff from '@pdslng/cio-icon/CioImageOff.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { Attachment } from 'svelte/attachments'
  import { DropdownMenu } from 'bits-ui'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { logRendererError } from '$lib/system/renderer-logger'
  import { formatCompactAge } from '$shared/date-time-format'
  import { workGroupState } from '$lib/stores/work-groups.svelte'
  import type {
    AuthoredWorkKind,
    DesignEntry,
    DesignThumbnail,
    WorkGroup,
    WorkGroupView
  } from '$shared/ipc-contract'

  /**
   * The designs of a project as a list the user arranges, rather than one folder in
   * front and the rest behind a menu.
   *
   * A project accumulates designs faster than it deletes them, and after a dozen
   * the board's question stops being "which one is this" and becomes "where is the
   * one I made for the pricing page". Groups answer that, and they are the user's
   * own arrangement: a group is a record about designs, never a place to put them,
   * so arranging the board never moves a folder, and deleting a group never
   * deletes any work.
   *
   * Two readings of the same work sit behind one toggle. The pictures answer what
   * a design looks like; the list answers where it is, folds a group away, and is
   * what a design is dragged through. Both are persisted, because a board that
   * reopened flat would undo the tidying the user did on a long project.
   */

  interface Props {
    projectId: string
    threadId: string
    kind: AuthoredWorkKind
    /** Every folder of this kind the project holds, newest first. */
    items: DesignEntry[]
    /** The folder the board is showing, so its row reads as the one in front. */
    selectedDirectory: string
    /** Show a design: the board goes back to it, which is the point of the list. */
    onSelect: (directory: string) => void
  }

  let { projectId, threadId, kind, items, selectedDirectory, onSelect }: Props = $props()

  /** A new group's name field takes the caret the moment the row appears, so
   *  naming a group is typing rather than a second click. */
  const focusSelf: Attachment<HTMLInputElement> = (element) => {
    element.focus()
  }

  const noun = $derived(kind === 'video' ? 'composition' : 'design')
  const nounPlural = $derived(kind === 'video' ? 'compositions' : 'designs')

  let board = $derived(workGroupState.stateFor(projectId, kind))
  let groups = $derived(board?.groups ?? [])
  /**
   * How this list draws its designs.
   *
   * The board in front is the cards reading (its Screen Canvas, live preview and
   * screens), so this surface is the folded list, and its default is that list
   * rather than a second grid of pictures. The persisted reading still wins when
   * one exists, so a window that was left in the other reading reopens as it was.
   */
  let view = $derived<WorkGroupView>(board?.view ?? 'list')

  /** Where each design sits, by folder, so a row knows its group without a scan. */
  let placement = $derived(
    new Map((board?.members ?? []).map((member) => [member.directory, member]))
  )
  /** Designs no group holds, which is every design of a project that never used
   *  groups and every design the agent has just written. */
  let ungrouped = $derived(items.filter((item) => !placement.has(item.directory)))

  function itemsIn(groupId: string): DesignEntry[] {
    const byDirectory = new Map(items.map((item) => [item.directory, item]))
    return (board?.members ?? [])
      .filter((member) => member.groupId === groupId)
      .toSorted((left, right) => left.position - right.position)
      .flatMap((member) => {
        const item = byDirectory.get(member.directory)
        // A membership whose folder is gone is not drawn: the design is what the
        // user lost track of, and an empty row would only say so twice.
        return item ? [item] : []
      })
  }

  function groupOf(directory: string): string | null {
    return placement.get(directory)?.groupId ?? null
  }

  // ─── Pictures of the designs ──────────────────────────────────────────────

  /**
   * One picture per design, filled in while the cards are on screen.
   *
   * Capturing is the expensive part of this panel, so it happens for the view that
   * needs it and only once per design: the store is this component's own, and the
   * `requested` signature is what stops a repaint from starting a second sweep.
   */
  let shots = $state<Record<string, DesignThumbnail>>({})
  let shotsRequested = ''
  let capturing = false

  async function captureMissing(directories: string[]): Promise<void> {
    if (capturing) return
    capturing = true
    try {
      for (const directory of directories) {
        if (shots[directory]) continue
        const shot = await invoke(
          'design:thumbnail',
          projectId,
          threadId,
          directory,
          null,
          360,
          kind
        )
        shots = { ...shots, [directory]: shot }
      }
    } catch (error) {
      logRendererError('Design pictures could not be captured', error)
    } finally {
      capturing = false
    }
  }

  $effect(() => {
    if (view !== 'cards') return
    const signature = items.map((item) => `${item.directory}:${item.updatedAt}`).join('|')
    if (signature === shotsRequested) return
    shotsRequested = signature
    void captureMissing(items.map((item) => item.directory))
  })

  // ─── Arranging ────────────────────────────────────────────────────────────

  /** The group whose menu or rename box is open, so one gestures at a time. */
  let renaming = $state('')
  let renameDraft = $state('')
  let creating = $state(false)
  let createDraft = $state('')
  let removing = $state<WorkGroup | null>(null)
  let error = $state('')

  /**
   * What is being dragged, kept out of reactive state on purpose: a pointer moving
   * across rows must not repaint the list, so only the drop target it is over is
   * reactive.
   */
  let dragging: { kind: 'design'; directory: string } | { kind: 'group'; id: string } | null = null
  let dropTarget = $state<{ groupId: string | null; index: number } | null>(null)
  let dropGroupId = $state('')

  function startDesignDrag(event: DragEvent, directory: string): void {
    dragging = { kind: 'design', directory }
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', directory)
  }

  function startGroupDrag(event: DragEvent, id: string): void {
    dragging = { kind: 'group', id }
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }

  function endDrag(): void {
    dragging = null
    dropTarget = null
    dropGroupId = ''
  }

  /** A design is over a position: offer it, and remember where it would land. */
  function overDesign(event: DragEvent, groupId: string | null, index: number): void {
    if (dragging?.kind !== 'design') return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    dropTarget = { groupId, index }
    dropGroupId = ''
  }

  /** A design is over a group's empty space: it would land at the end of it. */
  function overGroup(event: DragEvent, groupId: string | null, count: number): void {
    if (dragging?.kind === 'group') {
      event.preventDefault()
      dropGroupId = groupId ?? ''
      dropTarget = null
      return
    }
    overDesign(event, groupId, count)
  }

  async function dropDesign(event: DragEvent): Promise<void> {
    if (dragging?.kind !== 'design') return
    event.preventDefault()
    const target = dropTarget
    const directory = dragging.directory
    endDrag()
    if (!target) return
    if (groupOf(directory) === target.groupId && target.groupId === null) return
    try {
      await workGroupState.move(projectId, kind, [
        { directory, groupId: target.groupId, position: target.index }
      ])
      error = ''
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The design could not be moved'
    }
  }

  /** Reorder the groups themselves: the user dragged a group above another one. */
  async function dropGroup(targetId: string): Promise<void> {
    if (dragging?.kind !== 'group') return
    const moved = dragging.id
    endDrag()
    if (moved === targetId) return
    const order = groups.map((group) => group.id).filter((id) => id !== moved)
    const index = order.indexOf(targetId)
    if (index === -1) return
    order.splice(index, 0, moved)
    try {
      await workGroupState.reorder(projectId, kind, order)
      error = ''
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The groups could not be reordered'
    }
  }

  async function run(action: () => Promise<void>, failure: string): Promise<void> {
    try {
      await action()
      error = ''
    } catch (cause) {
      error = cause instanceof Error ? cause.message : failure
    }
  }

  function beginRename(group: WorkGroup): void {
    renaming = group.id
    renameDraft = group.name
  }

  async function commitRename(group: WorkGroup): Promise<void> {
    const name = renameDraft.trim()
    renaming = ''
    if (name === '' || name === group.name) return
    await run(() => workGroupState.rename(projectId, kind, group.id, name), 'Could not rename')
  }

  async function commitCreate(): Promise<void> {
    const name = createDraft.trim()
    if (name === '') {
      creating = false
      return
    }
    creating = false
    createDraft = ''
    await run(() => workGroupState.create(projectId, kind, name), 'Could not create the group')
  }

  async function toggleGroup(group: WorkGroup): Promise<void> {
    await run(
      () => workGroupState.setCollapsed(projectId, kind, group.id, !group.collapsed),
      'Could not fold the group'
    )
  }

  async function removeGroup(group: WorkGroup): Promise<void> {
    await run(() => workGroupState.remove(projectId, kind, group.id), 'Could not delete the group')
  }

  async function moveTo(directory: string, groupId: string | null): Promise<void> {
    await run(
      () => workGroupState.move(projectId, kind, [{ directory, groupId }]),
      'Could not move the design'
    )
  }

  $effect(() => {
    void workGroupState.ensure(projectId, kind)
  })
</script>

<div class="flex min-h-0 flex-1 flex-col">
  <div class="flex shrink-0 items-center gap-1 border-b border-border py-1.5 pl-2.5">
    <!-- The reading itself is the board's own header control; this row only holds
         what the list needs to arrange itself. -->
    <span class="min-w-0 flex-1"></span>
    <button
      type="button"
      class="flex h-6 shrink-0 items-center gap-1 border border-border px-1.5 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title={`Group these ${nounPlural} so the board stays readable`}
      aria-label={`New group of ${nounPlural}`}
      onclick={() => {
        creating = true
        createDraft = ''
      }}
    >
      <CioFolderPlus size={12} />
      Group
    </button>
  </div>

  {#if creating}
    <form
      class="flex shrink-0 items-center gap-1 border-b border-border py-1.5 pl-2.5"
      onsubmit={(event) => {
        event.preventDefault()
        void commitCreate()
      }}
    >
      <!-- A new group names itself where the groups are, so the user sees where it
           will land rather than answering a dialog about it. -->
      <input
        class="min-w-0 flex-1 border border-border bg-app px-1.5 py-0.5 text-[0.6875rem] text-foreground outline-none focus:border-primary"
        aria-label="New group name"
        placeholder="Group name"
        bind:value={createDraft}
        {@attach focusSelf}
      />
      <button
        type="submit"
        class="flex h-6 shrink-0 items-center gap-1 bg-primary px-1.5 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
        title="Create this group">Create</button
      >
      <button
        type="button"
        class="flex h-6 shrink-0 items-center px-1.5 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Cancel the new group"
        onclick={() => {
          creating = false
          createDraft = ''
        }}>Cancel</button
      >
    </form>
  {/if}

  {#if error !== ''}
    <p
      class="mx-2.5 mt-1.5 shrink-0 border border-danger/20 bg-danger/10 px-2 py-1 text-[0.6875rem] text-danger"
      role="alert"
    >
      {error}
    </p>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto py-1.5 pl-2.5">
    {#each groups as group (group.id)}
      {@const held = itemsIn(group.id)}
      <section
        class="mb-1.5 border border-border {dropGroupId === group.id ? 'border-primary/60' : ''}"
        aria-label={`Group ${group.name}`}
        ondragover={(event) => overGroup(event, group.id, held.length)}
        ondragleave={() => {
          if (!dragging) return
          dropTarget = null
          dropGroupId = ''
        }}
        ondrop={(event) => {
          if (dragging?.kind === 'group') {
            event.preventDefault()
            void dropGroup(group.id)
            return
          }
          void dropDesign(event)
        }}
      >
        <div class="flex items-center gap-1 bg-elevated px-1 py-0.5">
          <button
            type="button"
            class="flex h-5 w-5 shrink-0 cursor-grab items-center justify-center text-dimmed"
            draggable="true"
            title={`Drag to reorder the group ${group.name}`}
            aria-label={`Drag to reorder the group ${group.name}`}
            ondragstart={(event) => startGroupDrag(event, group.id)}
            ondragend={endDrag}
          >
            <CioGrip size={11} />
          </button>
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-1 text-left"
            title={`${group.collapsed ? 'Open' : 'Fold'} the group ${group.name}`}
            aria-label={`${group.collapsed ? 'Open' : 'Fold'} the group ${group.name}`}
            aria-expanded={!group.collapsed}
            onclick={() => void toggleGroup(group)}
          >
            <CioChevronDown
              size={11}
              class="shrink-0 text-dimmed transition-transform {group.collapsed
                ? '-rotate-90'
                : ''}"
            />
            {#if renaming === group.id}
              <input
                class="min-w-0 flex-1 border border-border bg-app px-1 text-[0.6875rem] font-semibold text-foreground outline-none focus:border-primary"
                aria-label={`Rename the group ${group.name}`}
                bind:value={renameDraft}
                onclick={(event) => event.stopPropagation()}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void commitRename(group)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    renaming = ''
                  }
                }}
                onblur={() => void commitRename(group)}
              />
            {:else}
              <span class="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold text-foreground"
                >{group.name}</span
              >
            {/if}
            <span class="shrink-0 text-[0.625rem] tabular-nums text-dimmed">{held.length}</span>
          </button>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-surface hover:text-foreground"
              title={`Group actions for ${group.name}`}
              aria-label={`Group actions for ${group.name}`}
            >
              <CioEllipsis size={11} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                class="z-50 min-w-40 border border-border bg-surface p-1 shadow-lg"
              >
                <DropdownMenu.Item
                  class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
                  onSelect={() => beginRename(group)}>Rename</DropdownMenu.Item
                >
                <DropdownMenu.Item
                  class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated"
                  onSelect={() => (removing = group)}>Delete group</DropdownMenu.Item
                >
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>

        {#if !group.collapsed}
          {#if held.length === 0}
            <p
              class="px-2 py-1.5 text-[0.625rem] text-dimmed"
              ondragover={(event) => overGroup(event, group.id, 0)}
              ondrop={(event) => void dropDesign(event)}
            >
              Drop {nounPlural} here, or drag one out to ungroup it.
            </p>
          {:else if view === 'cards'}
            <div class="grid grid-cols-2 gap-1.5 p-1.5" role="list">
              {#each held as item, index (item.directory)}
                {@render designCard(item, group.id, index)}
              {/each}
            </div>
          {:else}
            <div class="flex flex-col" role="list">
              {#each held as item, index (item.directory)}
                {@render designRow(item, group.id, index)}
              {/each}
            </div>
          {/if}
        {/if}
      </section>
    {/each}

    <section
      class="mb-1.5 border border-border {dropTarget?.groupId === null ? 'border-primary/60' : ''}"
      aria-label={`Ungrouped ${nounPlural}`}
      ondragover={(event) => overGroup(event, null, ungrouped.length)}
      ondragleave={() => {
        if (!dragging) return
        dropTarget = null
      }}
      ondrop={(event) => void dropDesign(event)}
    >
      <div class="flex items-center gap-1 bg-elevated px-1 py-0.5">
        <span class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed">
          <CioFolderPlus size={11} />
        </span>
        <span class="min-w-0 flex-1 truncate text-[0.6875rem] font-semibold text-foreground"
          >{groups.length > 0 ? 'Ungrouped' : `All ${nounPlural}`}</span
        >
        <span class="shrink-0 pr-1 text-[0.625rem] tabular-nums text-dimmed"
          >{ungrouped.length}</span
        >
      </div>
      {#if ungrouped.length === 0}
        <p class="px-2 py-1.5 text-[0.625rem] text-dimmed">
          {groups.length > 0
            ? 'Every design is in a group. Drag one back here to ungroup it.'
            : `The agent has not written a ${noun} yet. It will appear here when it does.`}
        </p>
      {:else if view === 'cards'}
        <div class="grid grid-cols-2 gap-1.5 p-1.5" role="list">
          {#each ungrouped as item, index (item.directory)}
            {@render designCard(item, null, index)}
          {/each}
        </div>
      {:else}
        <div class="flex flex-col" role="list">
          {#each ungrouped as item, index (item.directory)}
            {@render designRow(item, null, index)}
          {/each}
        </div>
      {/if}
    </section>
  </div>
</div>

{#snippet designCard(item: DesignEntry, groupId: string | null, index: number)}
  {@const shot = shots[item.directory]}
  {@const target =
    dropTarget?.groupId === groupId && dropTarget.index === index
      ? 'border-primary'
      : 'border-border'}
  <div
    class="group relative border {target} {item.directory === selectedDirectory
      ? 'border-accent/60'
      : ''} bg-elevated"
    role="listitem"
    draggable="true"
    ondragstart={(event) => startDesignDrag(event, item.directory)}
    ondragend={endDrag}
    ondragover={(event) => overDesign(event, groupId, index)}
    ondrop={(event) => void dropDesign(event)}
  >
    <button
      type="button"
      class="block w-full cursor-pointer text-left"
      title={item.missing ? `${item.name}, folder not found` : `Show the ${noun} ${item.name}`}
      aria-label={item.missing ? `${item.name}, folder not found` : `Show the ${noun} ${item.name}`}
      onclick={() => onSelect(item.directory)}
    >
      {#if shot?.dataUrl}
        <img
          src={shot.dataUrl}
          alt={`Preview of the ${noun} ${item.name}`}
          class="block max-h-32 w-full object-cover object-top"
        />
      {:else}
        <span class="flex aspect-[16/10] w-full items-center justify-center text-dimmed">
          {#if shot && shot.dataUrl === null}
            <CioImageOff size={13} />
          {:else}
            <CioSpinner size={12} class="animate-spin" />
          {/if}
        </span>
      {/if}
      <span class="flex items-center gap-1 px-1.5 py-1">
        <span class="min-w-0 flex-1 truncate text-[0.625rem] font-medium text-foreground"
          >{item.name}</span
        >
        {#if item.missing}
          <span class="shrink-0 text-[0.5625rem] text-warning">Not found</span>
        {/if}
      </span>
    </button>
    <span
      class="absolute top-0 right-0 flex items-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    >
      {@render moveMenu(item, groupId)}
    </span>
  </div>
{/snippet}

{#snippet designRow(item: DesignEntry, groupId: string | null, index: number)}
  {@const before =
    dropTarget?.groupId === groupId && dropTarget.index === index ? 'border-t-primary' : ''}
  <div
    class="flex items-center gap-1 border-t border-transparent {before} px-1 py-0.5 {item.directory ===
    selectedDirectory
      ? 'bg-accent/10'
      : 'hover:bg-elevated'}"
    role="listitem"
    draggable="true"
    ondragstart={(event) => startDesignDrag(event, item.directory)}
    ondragend={endDrag}
    ondragover={(event) => overDesign(event, groupId, index)}
    ondrop={(event) => void dropDesign(event)}
  >
    <span class="flex w-3 shrink-0 items-center justify-center text-dimmed" aria-hidden="true">
      <CioGrip size={10} />
    </span>
    <button
      type="button"
      class="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
      title={item.missing ? `${item.name}, folder not found` : `Show the ${noun} ${item.name}`}
      aria-label={item.missing ? `${item.name}, folder not found` : `Show the ${noun} ${item.name}`}
      onclick={() => onSelect(item.directory)}
    >
      <span class="min-w-0 flex-1 truncate text-[0.6875rem] text-foreground">{item.name}</span>
      {#if item.missing}
        <span class="shrink-0 text-[0.5625rem] text-warning">Not found</span>
      {/if}
      <span class="shrink-0 text-[0.5625rem] tabular-nums text-dimmed"
        >{formatCompactAge(item.updatedAt)}</span
      >
    </button>
    {@render moveMenu(item, groupId)}
  </div>
{/snippet}

{#snippet moveMenu(item: DesignEntry, groupId: string | null)}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-surface hover:text-foreground"
      title={`Move ${item.name} to another group`}
      aria-label={`Move ${item.name} to another group`}
    >
      <CioEllipsis size={11} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content class="z-50 min-w-44 border border-border bg-surface p-1 shadow-lg">
        {#each groups as group (group.id)}
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:opacity-40"
            disabled={group.id === groupId}
            onSelect={() => void moveTo(item.directory, group.id)}
          >
            <CioFolderPlus size={11} class="shrink-0 text-muted" />
            <span class="min-w-0 flex-1 truncate">{group.name}</span>
          </DropdownMenu.Item>
        {/each}
        {#if groupId !== null}
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
            onSelect={() => void moveTo(item.directory, null)}
          >
            <CioFolderPlus size={11} class="shrink-0 text-muted" />
            Ungrouped
          </DropdownMenu.Item>
        {/if}
        <DropdownMenu.Item
          class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
          onSelect={() => {
            creating = true
            createDraft = item.name
          }}
        >
          <CioPlus size={11} class="shrink-0 text-muted" />
          New group…
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/snippet}

<ConfirmDialog
  open={removing !== null}
  title="Delete this group?"
  confirmLabel="Delete group"
  onCancel={() => (removing = null)}
  onConfirm={() => {
    const group = removing
    removing = null
    if (group) void removeGroup(group)
  }}
>
  {#if removing}
    <p>
      The {nounPlural} in {removing.name} go back to the ungrouped list. Nothing on disk is deleted, and
      no folder moves.
    </p>
  {/if}
</ConfirmDialog>
