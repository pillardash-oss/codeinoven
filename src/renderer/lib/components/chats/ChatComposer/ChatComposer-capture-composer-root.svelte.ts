import { tick } from 'svelte'
import { toast } from 'svelte-sonner'
import type { Attachment } from 'svelte/attachments'
import { registerComposerFocusTarget } from '$lib/focus/composer-focus-registry'
import { posixBasename } from '$shared/paths'
import { showToastWarning } from '$lib/stores/app-errors.svelte'
import { invoke } from '$lib/ipc.svelte'
import { fileUrlToPath } from '$lib/mime'
import { placeCaretAtEnd } from '../../shared/rich-markdown'
import { handleComposerKeydown } from '../chat-composer-keydown'
import { handleComposerPaste } from '../chat-composer-paste'
import { type ComposerReadingSurface } from '../chat-composer-slash.svelte'
import { createComposerExpansion } from '../chat-composer-expand.svelte'
import { isImageAttachment } from '../chat-composer-attachments'
import { type ComposerAssistantTag } from '../composer-mentions'
import EngineeringToolbox from '../EngineeringToolbox.svelte'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { APP_NAME } from '$shared/brand'
import { getVendorIconSvg } from '$lib/vendor-icons/registry'
import ComposerShoe from '../ComposerShoe.svelte'
import type { ExpertDecisionInput, ThreadExpertState } from '$shared/ipc-contract'
import type { PromptAttachment } from '$shared/types'
import { MAX_PROMPT_ATTACHMENTS } from '$shared/types'
import type { ChatComposer } from './ChatComposer-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ChatComposer board. */
export class ChatComposerCaptureComposerRoot extends BoardUnit<ChatComposer> {
  constructor(root: ChatComposer) {
    super(root)
  }
  codeInOvenIconSvg = getVendorIconSvg(APP_NAME)

  projectReferenceIcons = $state<Record<string, string>>({})

  /** Root element of the composer, used to find the conversation region it sits in. */
  composerRoot = $state<HTMLElement | null>(null)

  captureComposerRoot: Attachment<HTMLElement> = (element) => {
    this.composerRoot = element
    // Publish this composer to the app-wide focus registry so the double-tap
    // primary-modifier gesture can return the caret here from anywhere in the
    // app. The composer owns how it takes focus, and refuses it while it is
    // disabled.
    const unregister = registerComposerFocusTarget({
      root: element,
      focus: () => {
        if (this.root.props.disabled) return false
        this.root.submit.focusComposerAtSavedCaret()
        return true
      }
    })
    return () => {
      unregister()
      if (this.composerRoot === element) this.composerRoot = null
    }
  }

  /** Maximize control   triples the editor's height and widens the composer to
   *  150% of its column for long-form writing. */
  expansion = createComposerExpansion({ getComposer: () => this.composerRoot })

  /** Resize the composer, then hand focus straight back to the caret so the user
   *  keeps typing in the surface they just enlarged. */
  toggleComposerExpansion(): void {
    this.expansion.toggle()
    this.root.submit.focusComposerAtSavedCaret()
  }

  /**
   * Expert gate state: a design or video session the user has not answered for
   * is held once, before the message goes, so the card can ask.
   */
  expertGateOpen = $state(false)

  expertGateState = $state<ThreadExpertState | null>(null)

  expertGateSession = $state<'design' | 'video'>('design')

  expertGateDirect = $state<boolean | undefined>(undefined)

  expertWarming = $state(false)

  /**
   * Every tag this composer can draw, by token.
   *
   * The Assistant tab hands its own assistants and threads over as props; a
   * thread picked from another project comes from the mention search instead,
   * which keeps the tag it found, so both read as a badge with their title and
   * their mark rather than as the raw token.
   */
  composerTags = $derived<ComposerAssistantTag[]>([
    ...this.root.props.assistantTags,
    ...this.root.submit.mentions.knownThreadTags.filter(
      (tag) =>
        !this.root.props.assistantTags.some(
          (known) => known.kind === tag.kind && known.id === tag.id
        )
    )
  ])

  lastCaretSupportsCommands: boolean | null = $state(null)

  engineeringToolbox: EngineeringToolbox | undefined = $state(undefined)

  /** The shoe instance, so the `/scope` slash action can open its picker. */
  shoeComponent: ComposerShoe | undefined = $state(undefined)

  /** The scope picker is live on the shoe (project mode, new thread)   gates
   *  the `/scope` slash action the same way the shoe's badge chevron does. */
  scopePickerAvailable = $derived(this.root.props.shoe?.scope?.isNewThread === true)

  // Selection slot hover popover   a short grace period keeps it open while the
  // pointer travels from the chip across any gap to the popover itself.
  selectionPopoverOpen = $state(false)

  selectionPopoverTimer: ReturnType<typeof setTimeout> | undefined = undefined

  /**
   * Whether a reference row's relocation menu is up.
   *
   * The menu is portaled outside the popover, so the pointer crosses out of the
   * popover to reach it. Plain book-keeping: it is only read while deciding
   * whether a hover-out may close the list, never rendered.
   */
  referenceMenuOpen = false

  startAfterPopoverOpen = $state(false)

  startAfterPopoverTimer: ReturnType<typeof setTimeout> | undefined = undefined

  openSelectionPopover(): void {
    clearTimeout(this.selectionPopoverTimer)
    this.selectionPopoverOpen = true
  }

  scheduleSelectionPopoverClose(): void {
    clearTimeout(this.selectionPopoverTimer)
    // A menu opened from a row outranks the pointer leaving: the list it was
    // opened from must still be there when the user comes back to it.
    if (this.referenceMenuOpen) return
    this.selectionPopoverTimer = setTimeout(() => {
      this.selectionPopoverOpen = false
    }, 220)
  }

  handleReferenceMenuOpenChange(open: boolean): void {
    this.referenceMenuOpen = open
    if (!open) this.scheduleSelectionPopoverClose()
  }

  toggleSelectionPopover(): void {
    if (this.selectionPopoverOpen) this.scheduleSelectionPopoverClose()
    else this.openSelectionPopover()
  }

  /** Close the popover immediately (e.g. after choosing an edit/delete action). */
  closeSelectionPopover(): void {
    clearTimeout(this.selectionPopoverTimer)
    this.selectionPopoverOpen = false
  }

  openStartAfterPopover(): void {
    clearTimeout(this.startAfterPopoverTimer)
    this.startAfterPopoverOpen = true
  }

  scheduleStartAfterPopoverClose(): void {
    clearTimeout(this.startAfterPopoverTimer)
    this.startAfterPopoverTimer = setTimeout(() => {
      this.startAfterPopoverOpen = false
    }, 220)
  }

  closeStartAfterPopover(): void {
    clearTimeout(this.startAfterPopoverTimer)
    this.startAfterPopoverOpen = false
  }

  clearStartAfterThreads(): void {
    this.root.handleDropData.startAfterEnabled = false
    this.root.handleDropData.startAfterThreads = []
    this.closeStartAfterPopover()
    this.root.props.onStartAfterThreadsChange?.([])
  }

  showScopeMenu(): void {
    this.root.handleDropData.closeAllMenus()
    this.shoeComponent?.openScopeMenu()
  }

  /** Opens one of the shoe's readings: the context battery (`/status`) or the
   *  generation rate (`/tps`). Neither takes arguments, so both run the moment
   *  they are picked from the menu or typed and submitted, exactly like `/scope`. */
  showReading(surface: ComposerReadingSurface): void {
    // A thread that has measured nothing yet has no rate to open, and a panel
    // that said only "measuring" would read as a command that did nothing.
    if (surface === 'rate' && !this.root.props.working && this.root.props.generationRate == null) {
      toast.info('No generation speed measured yet', {
        description: 'Send a message and the tokens-per-second reading is measured as it streams.'
      })
      return
    }
    this.shoeComponent?.openReading(surface)
  }

  currentProviders = $derived(
    this.root.props.projectId
      ? (providerCatalog.cached(this.root.props.projectId) ?? this.root.props.providers)
      : this.root.props.providers
  )

  hasImageAttachments = $derived(this.root.submit.attachments.some(isImageAttachment))

  textAttachmentError = $state('')

  cancelImageDescriptorGate(): void {
    this.root.handleDropData.imageDescriptorGateOpen = false
    this.root.submit.focusComposerAtSavedCaret()
  }

  /**
   * Read the thread's experts and its recorded answer.
   *
   * Null on any failure: the card is an offer, and a read that fails must let the
   * message go rather than hold it. The read happens on a user send, not in a
   * render loop, so it costs one indexed lookup and one small config read.
   */
  async readExpertState(): Promise<ThreadExpertState | null> {
    if (!this.root.props.projectId || !this.root.props.threadId) return null
    try {
      return await invoke('experts:state', this.root.props.projectId, this.root.props.threadId)
    } catch {
      return null
    }
  }

  /**
   * Start the harness while the card is on screen.
   *
   * The send is held for as long as the user reads the card, so the spawn they
   * would otherwise wait for happens behind it. Fire and forget: a warm-up that
   * fails changes nothing about the send that follows.
   */
  async warmSession(): Promise<void> {
    if (!this.root.props.projectId || !this.root.props.threadId) return
    this.expertWarming = true
    try {
      await invoke('agent:warmSession', this.root.props.projectId, this.root.props.threadId)
    } catch {
      // A warm-up is an optimization; its failure must not surface.
    } finally {
      this.expertWarming = false
    }
  }

  /** Record the card's answer, then send the message it was holding. */
  async decideExperts(choice: 'all' | 'off', silent: boolean): Promise<void> {
    const direct = this.expertGateDirect
    this.expertGateOpen = false
    const input: ExpertDecisionInput = { choice, silent }
    if (this.root.props.projectId && this.root.props.threadId) {
      try {
        this.expertGateState = await invoke(
          'experts:decide',
          this.root.props.projectId,
          this.root.props.threadId,
          input
        )
      } catch {
        // The decision is remembered for the next send; it must not block this one.
      }
    }
    this.root.submit.focusComposerAtSavedCaret()
    this.root.submit.performSend(direct)
  }

  hasText = $derived(this.root.submit.value.trim().length > 0)

  /** True when an attached reference is a payload in its own right, so an
   *  otherwise empty message can still be sent: a commented selection is the
   *  comment, and a mark drawn on a picture is the mark. */
  hasCommentReference = $derived(
    this.root.props.references.some(
      (reference) => Boolean(reference.comment) || reference.kind === 'image'
    )
  )

  /** Whether there is anything to send: text, an attachment, or a payload reference. */
  hasSendableContent = $derived(
    this.hasText || this.root.submit.attachments.length > 0 || this.hasCommentReference
  )

  /** Whether the button should show the stop icon (agent working, nothing to send). */
  canStop = $derived(this.root.props.working && !this.hasSendableContent)

  /** The mic stays mounted; only the send/stop control follows composer state. */
  showSendControl = $derived(
    !this.root.props.disabled && (this.root.props.working || this.hasSendableContent)
  )

  /** Which glyph the send control carries. The three stay mounted in one box and
   *  crossfade, so sending reads as the arrow morphing into the stop square
   *  rather than as one icon being swapped for another. */
  sendControlGlyph = $derived<'stop' | 'queue' | 'send'>(
    this.canStop ? 'stop' : this.root.props.working ? 'queue' : 'send'
  )

  hasThirdEditorLine = $state(false)

  /** Observe rendered height so wrapped lines and explicit newlines both count. */
  observeEditorLines(surface: HTMLDivElement): () => void {
    const editor = surface.querySelector<HTMLElement>('[role="textbox"]')
    if (!editor) return () => {}
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(editor)
      const contentHeight =
        editor.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
      this.hasThirdEditorLine = contentHeight > parseFloat(style.lineHeight) * 2 + 1
    })
    observer.observe(editor)
    return () => observer.disconnect()
  }

  /** Keep collapse available even after the expanded editor is cleared. */
  showExpandControl = $derived(this.hasThirdEditorLine || this.expansion.maximized)

  /** Focus the composer editor and place the caret at the end, in place. */
  focusComposerAtEnd(): void {
    void tick().then(() => {
      const editor = document.getElementById(this.root.submit.composerEditorId)
      if (!(editor instanceof HTMLDivElement)) return
      editor.focus()
      placeCaretAtEnd(editor)
    })
  }

  /** Replace the composer draft with the given text and focus the caret at
   *  the end   used by external surfaces such as suggested prompts that
   *  should seed a draft instead of sending it. */
  setComposerText(text: string): void {
    this.root.submit.value = text
    this.root.submit.handleComposerValueChange(text)
    void tick().then(() => {
      this.focusComposerAtEnd()
    })
  }

  /** Focus the composer editor and place the caret at the start of the first
   *  line   the fallback when no caret position was ever captured. */
  focusComposerAtStart(): void {
    void tick().then(() => {
      const editor = document.getElementById(this.root.submit.composerEditorId)
      if (!(editor instanceof HTMLDivElement)) return
      editor.focus()
      const range = document.createRange()
      range.setStart(editor, 0)
      range.collapse(true)
      const selection = window.getSelection()
      if (!selection) return
      selection.removeAllRanges()
      selection.addRange(range)
    })
  }

  /** Explain a drop or paste that only repeated files already attached, instead
   *  of letting it look like the composer silently ignored the gesture. */
  noticeDuplicateAttachments(duplicates: readonly PromptAttachment[]): void {
    const first = duplicates[0]
    if (!first) return
    const name = (first.filename ?? posixBasename(fileUrlToPath(first.url))) || 'That file'
    showToastWarning(
      duplicates.length === 1
        ? `${name} is already attached.`
        : `${duplicates.length} of those files are already attached.`
    )
  }

  /** Say what did not fit, so a drop past the file ceiling is never a silence. */
  noticeOverflowAttachments(overflow: readonly PromptAttachment[]): void {
    if (overflow.length === 0) return
    showToastWarning(
      overflow.length === 1
        ? `${overflow[0]?.filename ?? 'That file'} was not attached: a message carries at most ${MAX_PROMPT_ATTACHMENTS} files.`
        : `${overflow.length} of those files were not attached: a message carries at most ${MAX_PROMPT_ATTACHMENTS} files.`
    )
  }

  handlePaste(e: ClipboardEvent): void {
    void handleComposerPaste(e, this.root.handleDropData.pasteContext)
  }

  onWindowKeydown(e: KeyboardEvent): void {
    handleComposerKeydown(e, this.root.submit.keydownContext)
  }
}
