import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
import { archiveItem } from '$lib/archive-actions'
import CioBoard from '@pdslng/cio-icon/CioBoard.svelte'
import CioBookmark from '@pdslng/cio-icon/CioBookmark.svelte'
import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
import CioEyeOff from '@pdslng/cio-icon/CioEyeOff.svelte'
import CioFork from '@pdslng/cio-icon/CioFork.svelte'
import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
import CioPin from '@pdslng/cio-icon/CioPin.svelte'
import CioPinOff from '@pdslng/cio-icon/CioPinOff.svelte'
import CioSend from '@pdslng/cio-icon/CioSend.svelte'
import CioCircle from '@pdslng/cio-icon/CioCircle.svelte'
import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
import { THREAD_GROUP_MARK } from '$lib/components/threads/thread-state-marks'
import type { MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
import { copyText } from '$lib/copy-text'
import { feature } from '$lib/feature-registry'
import { invoke } from '$lib/ipc.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { threadUnreadIntent } from '$lib/stores/thread-unread-intent'
import { workspaceState } from '$lib/stores/workspace.svelte'
import {
  canUpdateThreadStatus,
  threadSettledOutcome,
  type ThreadSettledOutcome
} from '$shared/thread-status-policy'
import { threadTracksReadStatus, type Thread } from '$shared/types'
import { toast } from 'svelte-sonner'

export interface ThreadActionsMenuConfig {
  /** Resolved on every access   callers pass a getter so the menu tracks the current thread. */
  getThread: () => Thread | null | undefined
  onRename: (thread: Thread, newName: string) => Promise<void>
  onTogglePin: (thread: Thread) => void | Promise<void>
  onBookmark?: (thread: Thread) => void | Promise<void>
  showBookmark?: () => boolean
  onFork: (thread: Thread) => void | Promise<void>
  onDelete: (thread: Thread) => Promise<void>
  onDeleteError?: (error: unknown, thread: Thread) => void
  onOpenNotes?: (thread: Thread) => void
  showChangeScope?: () => boolean
  showNotes?: () => boolean
  showCopyId?: () => boolean
  /** Hand a thread off to a project. Assistant tasks only. */
  onHandoff?: (thread: Thread) => void
  showHandoff?: () => boolean
  /** Whether the thread is an assistant's knowledge thread. Such a thread is pinned
   *  for life and cannot be deleted, so its menu offers Hide and no destructive
   *  item instead of Pin/Unpin and Delete. */
  isKnowledgeThread?: () => boolean
  onHideKnowledge?: (thread: Thread) => void
}

/** One dropdown, one set of modals   shared by the app header and every thread row so the
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
      await copyText(thread.id, 'Thread ID copied.')
    } catch {
      toast.error('The thread ID could not be copied.')
    }
  }

  /**
   * Rewrite a settled thread's outcome from the user's menu.
   *
   * `unread` is recorded as an intent before the backend write so the
   * `thread:updated` broadcast that follows can never be auto-read away while the
   * thread stays open (see `threadUnreadIntent`); the other two outcomes drop any
   * such intent, because the user has just said the row is read.
   */
  async function updateStatus(outcome: ThreadSettledOutcome): Promise<void> {
    const thread = config.getThread()
    if (!thread || !canUpdateThreadStatus(thread.status)) return
    if (outcome === 'unread') threadUnreadIntent.mark(thread.id)
    else threadUnreadIntent.clear(thread.id)
    try {
      const updated = await invoke('thread:setSettledOutcome', thread.projectId, thread.id, outcome)
      scopeState.updateThread(updated)
      workspaceState.updateThread(updated)
    } catch (error) {
      if (outcome === 'unread') threadUnreadIntent.clear(thread.id)
      toast.error(error instanceof Error ? error.message : 'Could not update the thread status.')
    }
  }

  const items = $derived.by((): MenuItem[] => {
    const thread = config.getThread()
    if (!thread) return []
    const knowledgeThread = config.isKnowledgeThread?.() ?? false
    // The Getting started thread is the assistant's behavior record: it is not
    // renamed, pinned, re-scoped or moved, and it is not deleted on its own. The
    // menu offers what applies to it (hiding) and nothing that would rewrite it.
    const showScope = !knowledgeThread && (config.showChangeScope?.() ?? true)
    const showNotesItem = config.showNotes?.() ?? false
    const showCopyIdItem = config.showCopyId?.() ?? false
    const showHandoffItem = (config.showHandoff?.() ?? false) && config.onHandoff !== undefined
    const bookmarkAvailable = (config.showBookmark?.() ?? false) && config.onBookmark !== undefined
    // Only a settled thread has an outcome the user may rewrite: a finished run,
    // a run they stopped, or a failed one. Live work, a ready spec and a thread
    // parked on the user are states the app is still driving and are never
    // offered here (see `canUpdateThreadStatus`).
    //
    // Pawns and other orchestration children are included: a pawn row is a real
    // row on the delegation board with the same menu, and its failure is exactly
    // something the user may want to settle. Unread alone stays out of reach for
    // them, because such a row never presents a read state
    // (`threadTracksReadStatus`); offering it would promise a dot nobody draws.
    const tracksRead = threadTracksReadStatus(thread)
    const settledOutcome = canUpdateThreadStatus(thread.status)
      ? threadSettledOutcome(thread)
      : null
    // A row that does not track read has no unread reading: its finished run is
    // simply done, and its mark says so.
    const currentOutcome = settledOutcome === 'unread' && !tracksRead ? 'done' : settledOutcome
    // The entries wear the inbox's own marks (`THREAD_GROUP_MARK`), the exact
    // glyphs the Threads view paints on the Unread, Done and Errors group
    // headers, so the menu and the list it acts on can never disagree.
    const statusItems: MenuItem[] =
      settledOutcome === null
        ? []
        : [
            {
              label: 'Update status',
              icon: CioCircle,
              children: [
                ...(tracksRead
                  ? [
                      {
                        label: 'Unread',
                        icon: THREAD_GROUP_MARK.Unread.icon,
                        selected: currentOutcome === 'unread',
                        onClick: () => void updateStatus('unread')
                      }
                    ]
                  : []),
                {
                  label: 'Done',
                  icon: THREAD_GROUP_MARK.Done.icon,
                  selected: currentOutcome === 'done',
                  onClick: () => void updateStatus('done')
                },
                {
                  label: 'Error',
                  icon: THREAD_GROUP_MARK.Errors.icon,
                  selected: currentOutcome === 'error',
                  onClick: () => void updateStatus('error')
                }
              ]
            }
          ]
    return [
      ...(knowledgeThread ? [] : [{ label: 'Rename', icon: CioPencil, onClick: startRename }]),
      ...statusItems,
      ...(knowledgeThread
        ? [
            {
              label: 'Hide getting started',
              icon: CioEyeOff,
              onClick: () => config.onHideKnowledge?.(thread)
            }
          ]
        : [
            ...(thread.bookmarked || bookmarkAvailable
              ? [
                  {
                    label: thread.bookmarked ? 'Remove bookmark' : 'Bookmark thread',
                    icon: CioBookmark,
                    onClick: () =>
                      void (thread.bookmarked
                        ? config.onTogglePin(thread)
                        : config.onBookmark?.(thread))
                  }
                ]
              : []),
            ...(!thread.bookmarked
              ? [
                  {
                    label: thread.pinned ? 'Unpin' : 'Pin',
                    icon: thread.pinned ? CioPinOff : CioPin,
                    onClick: () => void config.onTogglePin(thread)
                  }
                ]
              : [])
          ]),
      { label: 'Fork', icon: CioFork, onClick: () => void config.onFork(thread) },
      ...(showHandoffItem
        ? [
            {
              label: 'Hand off to project',
              icon: CioSend,
              onClick: () => config.onHandoff?.(thread)
            }
          ]
        : []),
      ...(showScope ? [{ label: 'Change Scope', icon: CioBoard, onClick: startChangeScope }] : []),
      ...(showNotesItem
        ? [
            {
              label: feature('thread-note').name,
              icon: feature('thread-note').icon,
              onClick: () => config.onOpenNotes?.(thread)
            }
          ]
        : []),
      ...(showCopyIdItem
        ? [{ label: 'Copy thread id', icon: CioCopy, onClick: () => void copyThreadId() }]
        : []),
      // A knowledge thread cannot be deleted: hiding is the only way to get it out
      // of the list, and it can always be revealed again from the knowledge panel.
      ...(knowledgeThread
        ? []
        : [
            {
              label: 'Archive thread',
              icon: CioArchive,
              onClick: () => void archiveItem('thread', thread.id, thread.title)
            },
            { label: '', divider: true }
          ]),
      ...(knowledgeThread
        ? []
        : [{ label: 'Delete', icon: CioTrash, onClick: startDelete, danger: true }])
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
