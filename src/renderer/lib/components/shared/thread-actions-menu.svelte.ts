import { Pencil, Pin, PinOff, GitFork, Kanban, StickyNote, Copy, Trash2 } from '@lucide/svelte'
import { toast } from 'svelte-sonner'
import type { MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { copyText } from '$lib/copy-text'
import type { Thread } from '$shared/types'

export interface ThreadActionsMenuConfig {
  /** Resolved on every access — callers pass a getter so the menu tracks the current thread. */
  getThread: () => Thread | null | undefined
  onRename: (thread: Thread, newName: string) => Promise<void>
  onTogglePin: (thread: Thread) => void | Promise<void>
  onFork: (thread: Thread) => void | Promise<void>
  onDelete: (thread: Thread) => Promise<void>
  onDeleteError?: (error: unknown, thread: Thread) => void
  onOpenNotes?: (thread: Thread) => void
  showChangeScope?: () => boolean
  showNotes?: () => boolean
  showCopyId?: () => boolean
}

/** One dropdown, one set of modals — shared by the app header and every thread row so the
 *  "..." menu can never drift between the two surfaces again. */
export function createThreadActionsMenu(config: ThreadActionsMenuConfig) {
  let showRenameModal = $state(false)
  let renameValue = $state('')
  let renameError = $state<string | null>(null)
  let showDeleteModal = $state(false)
  let showChangeScopeModal = $state(false)

  function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback
  }

  function startRename(): void {
    const thread = config.getThread()
    if (!thread) return
    renameValue = thread.title
    renameError = null
    showRenameModal = true
  }

  async function confirmRename(): Promise<void> {
    const thread = config.getThread()
    if (!thread || !renameValue.trim()) return
    try {
      renameError = null
      await config.onRename(thread, renameValue.trim())
      showRenameModal = false
    } catch (error) {
      renameError = errorMessage(error, 'Could not rename thread')
    }
  }

  function cancelRename(): void {
    showRenameModal = false
  }

  function startDelete(): void {
    if (!config.getThread()) return
    showDeleteModal = true
  }

  async function confirmDelete(): Promise<void> {
    const thread = config.getThread()
    if (!thread) return
    try {
      await config.onDelete(thread)
      showDeleteModal = false
    } catch (error) {
      config.onDeleteError?.(error, thread)
    }
  }

  function cancelDelete(): void {
    showDeleteModal = false
  }

  function startChangeScope(): void {
    const thread = config.getThread()
    if (!thread) return
    void scopeState.ensureBoardLoaded(thread.projectId)
    showChangeScopeModal = true
  }

  function cancelChangeScope(): void {
    showChangeScopeModal = false
  }

  async function copyThreadId(): Promise<void> {
    const thread = config.getThread()
    if (!thread) return
    try {
      await copyText(thread.id)
      toast.success('Thread ID copied.')
    } catch {
      toast.error('The thread ID could not be copied.')
    }
  }

  const items = $derived.by((): MenuItem[] => {
    const thread = config.getThread()
    if (!thread) return []
    const showScope = config.showChangeScope?.() ?? true
    const showNotesItem = config.showNotes?.() ?? false
    const showCopyIdItem = config.showCopyId?.() ?? false
    return [
      { label: 'Rename', icon: Pencil, onClick: startRename },
      {
        label: thread.pinned ? 'Unpin' : 'Pin',
        icon: thread.pinned ? PinOff : Pin,
        onClick: () => void config.onTogglePin(thread)
      },
      { label: 'Fork', icon: GitFork, onClick: () => void config.onFork(thread) },
      ...(showScope
        ? [{ label: 'Change Scope', icon: Kanban, onClick: startChangeScope }]
        : []),
      ...(showNotesItem
        ? [
            {
              label: 'Notes',
              icon: StickyNote,
              onClick: () => config.onOpenNotes?.(thread)
            }
          ]
        : []),
      ...(showCopyIdItem
        ? [{ label: 'Copy thread id', icon: Copy, onClick: () => void copyThreadId() }]
        : []),
      { label: '', divider: true },
      { label: 'Delete', icon: Trash2, onClick: startDelete, danger: true }
    ] as MenuItem[]
  })

  return {
    get items(): MenuItem[] {
      return items
    },
    get showRenameModal(): boolean {
      return showRenameModal
    },
    get renameValue(): string {
      return renameValue
    },
    set renameValue(value: string) {
      renameValue = value
    },
    get renameError(): string | null {
      return renameError
    },
    get showDeleteModal(): boolean {
      return showDeleteModal
    },
    get showChangeScopeModal(): boolean {
      return showChangeScopeModal
    },
    startRename,
    confirmRename,
    cancelRename,
    startDelete,
    confirmDelete,
    cancelDelete,
    startChangeScope,
    cancelChangeScope
  }
}

export type ThreadActionsMenu = ReturnType<typeof createThreadActionsMenu>
