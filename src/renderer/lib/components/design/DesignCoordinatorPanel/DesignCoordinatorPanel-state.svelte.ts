import type { Attachment } from 'svelte/attachments'
import { browserAudio } from '$lib/stores/browser-audio.svelte'
import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'
import { copyText } from '$lib/copy-text'
import { designCopyFor } from '$lib/design-copy-context'
import { revealInOsFileManager } from '$lib/os-file-manager'
import { logRendererError } from '$lib/system/renderer-logger'
import type { ScreenOrder } from './DesignCoordinatorPanel-types'
import type { DesignBoard } from './DesignCoordinatorPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the DesignBoard board. */
export class DesignBoardState extends BoardUnit<DesignBoard> {
  constructor(root: DesignBoard) {
    super(root)
  }
  /** Export playback participates in the same sound registry as native views. */
  attachExport: Attachment<HTMLVideoElement> = (element) => {
    const audioId = `video-export:${this.root.props.projectId}:${this.root.props.threadId}`
    const report = (): void => {
      browserAudio.reportThreadTab(
        audioId,
        this.root.props.threadId,
        this.root.props.projectId,
        !element.paused && !element.ended && !element.muted && element.volume > 0
      )
    }
    const events = ['play', 'pause', 'ended', 'volumechange'] as const
    for (const event of events) element.addEventListener(event, report)
    $effect(() => {
      if (!this.root.props.active) element.pause()
    })
    return () => {
      element.pause()
      for (const event of events) element.removeEventListener(event, report)
      browserAudio.forget(audioId)
    }
  }

  /** What each order is called in the Sort menu. */
  SCREEN_ORDER_LABELS: Record<ScreenOrder, string> = {
    latest: 'Latest',
    name: 'Name A-Z',
    'name-desc': 'Name Z-A',
    oldest: 'Oldest',
    custom: 'Custom'
  }

  /**
   * Whether a turn settled while the board was off screen.
   *
   * A board the user is not looking at has nothing to show, so its screens are not
   * re-pictured behind their back; the flag is what the effect below reads when the
   * board comes back. Deliberately not reactive: nothing renders it.
   */
  settleMissed = false

  /**
   * Whether the history pane is on screen.
   *
   * The pane is what makes iteration safe, so it is one click from the board rather
   * than a detour: the design stays in the top half and its history opens under it.
   */
  historyOpen = $state(false)

  detailsMode = $state<'this' | 'all' | 'rename' | null>(null)

  /**
   * Copy a design folder, or one screen inside it, in the form the asking agent
   * can use.
   *
   * The decision lives in the copy helper: a tag when the board's thread shares
   * the project, scope and machine the design lives on, an absolute path when it
   * does not, and the way to reach another Oven when the design is on one.
   */
  /**
   * Show the design folder in the file tree: it opens the files surface,
   * expands the ancestors and selects the entry, so the design lands in the
   * same tree every other path citation uses instead of a folder the user has
   * to find again.
   *
   * The folder is relative to the scope of the thread whose work the board is
   * showing, which for a chat, an assistant task or a browser tab is that
   * conversation's workspace and not the project root. The tree mounts one scope
   * at a time, so a design recorded in a scope the user has since left (a thread
   * that moved to another worktree, a folder that was moved) cannot be shown
   * there. That is not a dead end: the folder still exists, so the app opens it
   * in the OS file manager and says why the tree did not take it.
   */
  async revealDesignPath(directory: string): Promise<void> {
    if (directory === '') return
    const { projectId } = this.root.props
    const threadId = this.root.gallery.selectionThreadId
    try {
      const { revealScopeRelativePath } = await import('$lib/reveal-file')
      if (await revealScopeRelativePath(projectId, threadId, directory)) return
      const absolutePath = await invoke('design:folderPath', projectId, threadId, directory)
      if (absolutePath !== '' && (await revealInOsFileManager(absolutePath))) {
        toast.info(
          'The current thread is not in the same scope as the design, revealing it in your OS file manager.'
        )
        return
      }
      toast.error('The design could not be revealed. It may have been moved or deleted.')
    } catch (failure) {
      logRendererError('The design could not be revealed.', failure)
      toast.error('The design could not be revealed. It may have been moved or deleted.')
    }
  }

  async copyDesignPath(directory: string, entry: string | null = null): Promise<void> {
    if (directory === '') return
    const payload = designCopyFor(directory, entry)
    if (payload === null) {
      toast.error('This design cannot be copied.')
      return
    }
    try {
      await copyText(payload.text, payload.message)
    } catch (failure) {
      logRendererError('The design path could not be copied.', failure)
      toast.error('The design path could not be copied.')
    }
  }
}
