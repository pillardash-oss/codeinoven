import { flushSync, tick } from 'svelte'
import { placeCaretAtEnd } from '../../shared/rich-markdown'
import { type ComposerKeydownContext } from '../chat-composer-keydown'
import { isSlashRoutedAction, composerReadingSurface } from '../chat-composer-slash.svelte'
import { createComposerMentionSearch } from '../chat-composer-mentions.svelte'
import {
  abbreviatedTaskTitle,
  partitionNewAttachments,
  projectReferenceToken,
  restoredDraft,
  taskReferenceToken,
  uniqueAttachments
} from '../chat-composer-attachments'
import {
  normalizeComposerMessage,
  COMPOSER_BUILT_IN_TAGS,
  composerAssistantTagToken,
  composerMentionReplacePattern,
  composerMentionStart,
  type ComposerMentionEntry
} from '../composer-mentions'
import RichMarkdownEditor from '../../shared/RichMarkdownEditor.svelte'
import { speechController } from '../../../speech/speech-controller.svelte'
import { filterActions, permissionLevelForAction } from '$lib/actions'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { cioSearchVisibility } from '$lib/stores/cio-search-visibility.svelte'
import { sessionTagKind } from '$shared/session-tags'
import { expertSessionFor, shouldOfferExpertCard } from '$shared/experts'
import type { SpeechEditorApplyResult, SpeechEditorTarget } from '../../../speech/editor-target'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import type { RichInlineBadge } from '../../shared/rich-markdown'
import type {
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  AssignmentTask
} from '$shared/types'
import { MAX_PROMPT_ATTACHMENTS } from '$shared/types'
import type { ChatComposer } from './ChatComposer-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ChatComposer board. */
export class ChatComposerSubmit extends BoardUnit<ChatComposer> {
  constructor(root: ChatComposer) {
    super(root)
  }

  /** Set from `bind()`: the editor's id names its project and thread. */
  bindEditorId(): void {
    this.composerEditorId = `chat-composer-${this.root.props.projectId ?? 'no-project'}-${this.root.props.threadId ?? 'none'}`
  }

  /**
   * The mounted editor.
   *
   * The field itself is optional because the template binds it, and a binding
   * starts out empty; every method here runs from an event the editor can only
   * raise once it exists, so this reads it once and states that.
   */
  private get editor(): RichMarkdownEditor {
    const editor = this.richEditor
    if (!editor) throw new Error('The composer editor is not mounted')
    return editor
  }
  value = $state('')

  // The composer is remounted by the parent when a restore is required, so we
  // intentionally capture only the initial attachments passed at creation time.
  // Drafts restored from a session that ran before the duplicate guard can hold
  // the same file twice, which the keyed attachment chips cannot render, so the
  // restored list is collapsed here before it ever reaches the markup.
  attachments = $state<PromptAttachment[]>([])

  projectReferences = $state<PromptProjectReference[]>([])

  taskReferences = $state<PromptAssignmentTaskReference[]>([])

  /**
   * Capture the draft the surface handed over.
   *
   * These fields are born from the props, and the props only exist once the
   * board is bound, so the board calls this immediately after construction
   * rather than reading `root` in a field initializer.
   */
  bind(): void {
    const props = this.root.props
    this.value = restoredDraft(
      props.initialValue,
      props.initialProjectReferences,
      props.initialTaskReferences
    )
    this.attachments = uniqueAttachments(props.initialAttachments).slice(0, MAX_PROMPT_ATTACHMENTS)
    this.projectReferences = [...props.initialProjectReferences]
    this.taskReferences = [...props.initialTaskReferences]
  }

  /**
   * Whether a mention query may span spaces.
   *
   * Thread search is the only thing that needs it: a thread is named by its
   * title, so a query that ended at the first space could never name one.
   */
  mentionSpansSpaces = $derived(cioSearchVisibility.includeThreads)

  /** Set by `bind()`: the id of the editor the surface renders. */
  composerEditorId = ''

  mentions = createComposerMentionSearch({
    getAssignmentTasks: () => this.root.props.assignmentTasks,
    getFileTagProjectId: () => this.root.props.fileTagProjectId,
    getAssistantTags: () => this.root.props.assistantTags
  })

  projectReferenceBadges = $derived<RichInlineBadge[]>([
    ...COMPOSER_BUILT_IN_TAGS.filter((tag) => this.value.includes(tag.token)).map((tag) => ({
      iconSvg: this.root.captureComposerRoot.codeInOvenIconSvg,
      label: tag.chipLabel,
      title: `${tag.token} · ${tag.description}`,
      value: tag.token
    })),
    ...this.projectReferences.map((reference) => ({
      iconSvg:
        this.root.captureComposerRoot.projectReferenceIcons[projectReferenceToken(reference)],
      label: reference.name,
      title: `${reference.kind === 'directory' ? 'Directory' : 'File'}: ${reference.path}`,
      value: projectReferenceToken(reference)
    })),
    ...this.taskReferences.map((reference) => ({
      label: abbreviatedTaskTitle(reference.title),
      title: `Task: ${reference.title} · Worker: ${reference.workerName ?? 'Unassigned'}`,
      value: taskReferenceToken(reference)
    })),
    // A tagged assistant or thread reads as its mark plus its name, never as the
    // id the token carries: the id is what the agent needs, not what the writer
    // should have to look at.
    ...this.root.captureComposerRoot.composerTags
      .filter((tag) => this.value.includes(composerAssistantTagToken(tag)))
      .map((tag) => ({
        iconSvg: tag.iconHtml,
        accentColor: tag.color,
        label: abbreviatedTaskTitle(tag.name),
        title: `Open ${tag.detail}: ${tag.name}`,
        value: composerAssistantTagToken(tag)
      }))
  ])

  /**
   * The `@` the user dismissed with Escape. While the caret stays inside that
   * one token the menu stays shut, so a dismissed suggestion list cannot pop
   * back on the next keystroke; another `@`, or leaving the token, clears it and
   * suggestions resume.
   */
  dismissedMentionStart: number | null = $state(null)

  slashOpen = $state(false)

  slashQuery = $state('')

  slashIndex = $state(0)

  /** Guards the async resolve against a second send landing inside its window. */
  resolvingSend = false

  lastCaretText: string | null = $state(null)

  richEditor!: RichMarkdownEditor

  composerSpeechTarget(): SpeechEditorTarget | null {
    const editorTarget = this.richEditor?.speechEditorTarget(this.composerEditorId) ?? null
    if (!editorTarget) return null

    return {
      id: editorTarget.id,
      capture: () => editorTarget.capture(),
      apply: (snapshot, transcript) => editorTarget.apply(snapshot, transcript),
      // Armed voice dictation dispatches through the composer itself (see
      // `SpeechEditorAutoSend`), so a voice send obeys the same queue/steer
      // rules as the send button.
      autoSend: {
        isLive: () => this.richEditor?.speechEditorTarget(this.composerEditorId)?.capture() != null,
        submit: (direct) => this.submit(direct)
      },
      fallbackApply: (snapshot, transcript): SpeechEditorApplyResult => {
        if (
          !this.root.props.projectId ||
          !this.root.props.threadId ||
          typeof this.root.props.onValueChange !== 'function'
        ) {
          return { ok: false, reason: 'destroyed' }
        }
        const base = rendererRecovery.draftFor(this.root.props.projectId, this.root.props.threadId)
        const baseMatchesSnapshot =
          snapshot.targetId === this.composerEditorId && snapshot.value === base

        let start: number
        let next: string
        if (baseMatchesSnapshot) {
          const selectionStart = Math.min(snapshot.selection.anchor, snapshot.selection.focus)
          const selectionEnd = Math.max(snapshot.selection.anchor, snapshot.selection.focus)
          start = selectionStart
          next = base.slice(0, selectionStart) + transcript + base.slice(selectionEnd)
        } else if (base.length === 0) {
          start = 0
          next = transcript
        } else {
          const separator = /\s$/.test(base) ? '' : ' '
          start = base.length + separator.length
          next = base + separator + transcript
        }

        this.root.props.onValueChange(next)
        return {
          ok: true,
          value: next,
          startOffset: start,
          endOffset: start + transcript.length
        }
      }
    }
  }

  /**
   * Hold this send for the expert card, or let it go.
   *
   * The card has one question, scoped to a session: may this design or video
   * session hand its craft work to the models the user staffed. It is asked on
   * the send that opens a session and on later sends until the thread answers,
   * and it comes back only when the expert list itself changed. Everything else
   * sends straight through.
   */
  async offerExpertCardOrSend(msg: string, direct?: boolean): Promise<void> {
    const state = await this.root.captureComposerRoot.readExpertState()
    const session = expertSessionFor(sessionTagKind(msg), state?.session ?? null)
    if (
      !state ||
      !shouldOfferExpertCard({
        session,
        expertCount: state.experts.length,
        decision: state.decision,
        signature: state.signature
      })
    ) {
      this.performSend(direct)
      return
    }
    this.root.captureComposerRoot.expertGateState = state
    this.root.captureComposerRoot.expertGateSession = session === 'video' ? 'video' : 'design'
    this.root.captureComposerRoot.expertGateDirect = direct
    this.root.captureComposerRoot.expertGateOpen = true
    void this.root.captureComposerRoot.warmSession()
  }

  slashActions = $derived(filterActions(this.root.handleDropData.slash.available, this.slashQuery))

  pendingStop = $state(false)

  pendingStopTimer: ReturnType<typeof setTimeout> | undefined = undefined

  historyIndex = $state(-1)

  savedValue = $state('')

  /** Arms the stop confirmation on the first press; the second press calls
   *  `onStop`. Shared by the stop button and the Escape-key flow so both paths
   *  show the same visual armed state. */
  confirmStop(): void {
    if (!this.root.props.onStop) return
    if (this.pendingStop) {
      clearTimeout(this.pendingStopTimer)
      this.pendingStop = false
      this.root.props.onStop()
      return
    }
    this.pendingStop = true
    this.pendingStopTimer = setTimeout(() => {
      this.pendingStop = false
    }, 3000)
  }

  cancelStop(): void {
    clearTimeout(this.pendingStopTimer)
    this.pendingStop = false
  }

  /** Focus the composer editor and restore the caret to the position the user
   *  last had inside it   published continuously by the rich editor via its
   *  selection tracking. Falls back to the end when no position is known.
   *  This is the right default whenever an overlay that stole focus (menu,
   *  attachment preview, picker) closes: typing resumes exactly where it left
   *  off instead of the caret jumping to the end. */
  focusComposerAtSavedCaret(): void {
    void tick().then(() => {
      this.richEditor?.focusAtBookmark(this.richEditor.caretBookmark())
    })
  }

  selectSlashAction(action: ActionDefinition, method: ActionSelection['method']): void {
    if (action.disabledReason) return
    const selectedQuery = this.slashQuery
    this.slashOpen = false

    const replacement = isSlashRoutedAction(action) ? `${action.title} ` : ''
    const replaced = this.editor.replaceTextBeforeCaret(
      /(^|\s)\/[^\s/]*$/u,
      (_match, prefix) => `${prefix}${replacement}`
    )
    if (!replaced) return

    const reading = composerReadingSurface(action.id)
    if (reading) {
      this.root.captureComposerRoot.showReading(reading)
      return
    }

    if (action.id === 'selector:models') {
      this.root.handleDropData.showModelMenu()
      return
    }

    if (action.id === 'selector:model-setting') {
      this.root.handleDropData.showModelSettingsMenu()
      return
    }

    if (action.id === 'selector:profiles') {
      this.root.handleDropData.showProfilesMenu()
      return
    }

    if (action.id === 'selector:thinking') {
      // Thinking level lives in the shared model picker's dropdown   open it directly.
      this.root.handleDropData.showThinkingMenu()
      return
    }

    if (action.id === 'selector:account') {
      // The account picker lives in the shared model picker's dropdown   open it directly.
      this.root.handleDropData.showAccountMenu()
      return
    }

    if (action.id === 'selector:oven') {
      this.root.props.shoe?.onOpenOven?.()
      return
    }

    if (action.id === 'selector:scope') {
      // The scope picker lives in the shoe under the composer   open it directly.
      this.root.captureComposerRoot.showScopeMenu()
      return
    }

    if (action.id === 'mode:file-system') {
      // Same commit path as the plus-menu switch, chat mode only. Selecting the
      // action has already consumed the typed `/query` text.
      this.root.handleDropData.toggleFileSystemMode()
      return
    }

    // Chat mode: the slash menu offers the permission levels once File System is
    // on, and the picker chip takes the exact same commit path.
    const permissionLevel = permissionLevelForAction(action)
    if (permissionLevel) {
      this.root.handleDropData.selectPermission(permissionLevel)
      return
    }

    if (isSlashRoutedAction(action)) {
      return
    }

    void this.root.props.onActionSelect?.({ action, query: selectedQuery, method })
  }

  async submit(direct?: boolean): Promise<void> {
    if (this.mentions.open && this.mentions.entries[this.mentions.index]) {
      this.selectMention(this.mentions.entries[this.mentions.index])
      return
    }
    const selectedSlashAction = this.slashActions[this.slashIndex]
    if (this.slashOpen && selectedSlashAction) {
      this.selectSlashAction(selectedSlashAction, 'keyboard')
      return
    }
    if (this.root.props.disabled) return
    if (this.root.props.working && !this.root.captureComposerRoot.hasSendableContent) {
      this.confirmStop()
      return
    }
    this.cancelStop()
    // A tag typed but never picked still targets what it names. Resolve it
    // before anything reads the draft, so the expert gate sees a session tag
    // and the dispatched turn carries the tagged reference.
    if (this.resolvingSend) return
    this.resolvingSend = true
    try {
      await this.resolveTypedTargetsIntoDraft()
    } finally {
      this.resolvingSend = false
    }
    const msg = normalizeComposerMessage(this.value, this.projectReferences)
    if (!msg && this.attachments.length === 0 && !this.root.captureComposerRoot.hasCommentReference)
      return
    this.historyIndex = -1
    this.savedValue = ''
    const slashCommand = /^\/([^\s]+)(?:\s+([\s\S]*))?$/u.exec(msg)
    if (slashCommand) {
      const name = slashCommand[1]
      // The composer's own readings take no arguments, so a typed one runs here
      // instead of leaving as a prompt the agent has to read.
      const readingAction = this.root.handleDropData.slash.available.find(
        (candidate) =>
          candidate.title === `/${name}` && composerReadingSurface(candidate.id) !== undefined
      )
      const reading = readingAction ? composerReadingSurface(readingAction.id) : undefined
      if (reading) {
        this.value = ''
        this.slashOpen = false
        this.root.props.onValueChange?.('')
        this.root.captureComposerRoot.showReading(reading)
        return
      }
      const action = this.root.props.onSlashCommand
        ? this.root.props.actions.find(
            (candidate) => isSlashRoutedAction(candidate) && candidate.title === `/${name}`
          )
        : undefined
      if (action) {
        if (action.disabledReason) return
        this.value = ''
        this.slashOpen = false
        this.root.props.onValueChange?.('')
        void this.root.props.onSlashCommand?.(action.id, slashCommand[2]?.trim() ?? '')
        return
      }
    }
    if (this.root.handleDropData.selectedHarnessLacksAttachments && this.attachments.length > 0) {
      this.root.handleDropData.attachmentBlockedNotice = true
      return
    }
    // Nothing to send with: let the host show its setup card instead of
    // handing the driver a turn it can only reject. The draft stays intact.
    if (this.root.handleDropData.needsAiAccount && this.root.props.onNeedsAiAccount) {
      this.root.props.onNeedsAiAccount()
      return
    }
    // When working and not direct, the parent (ThreadView) queues the message instead of sending it.
    // We still clear the input so the user can type their next message.
    if (this.root.handleDropData.shouldInterceptImageGate()) {
      this.root.handleDropData.openImageDescriptorGate(direct)
      return
    }
    // A design or video session holds its send once, so the expert card can ask.
    // Reading the answer is one call on the user's own action, and the common
    // case (a thread that already answered, or a plain message) sends through.
    if (this.root.props.projectId && this.root.props.threadId) {
      void this.offerExpertCardOrSend(msg, direct)
      return
    }
    this.performSend(direct)
  }

  performSend(direct?: boolean): void {
    // The chosen model's harness is not on the Oven, so this turn cannot run.
    // Hold the draft instead of dispatching a run the Oven would fail.
    if (this.root.handleDropData.ovenModelUnavailable) return
    if (this.root.handleDropData.selectedHarnessLacksAttachments && this.attachments.length > 0) {
      this.root.handleDropData.attachmentBlockedNotice = true
      return
    }
    const msg = normalizeComposerMessage(this.value, this.projectReferences)
    speechController.observeSent(this.composerEditorId, msg)
    this.value = ''
    this.root.props.onValueChange?.('')
    // The words the user just sent live in the editor's own DOM, and the editor
    // empties that DOM from its value sync, which Svelte otherwise runs a
    // microtask later. Flush it here, at the instant the draft is handed away, so
    // nothing the browser already has in flight   an input event from a
    // composition or a repeat, a re-render that reads the editor back   can
    // serialize the old words out of the DOM and refill the composer with the
    // message the agent is already answering.
    flushSync()
    const files = [...this.attachments]
    const taggedPaths = [...this.projectReferences]
    const taggedTasks = [...this.taskReferences]
    this.root.handleDropData.preview.reset()
    this.attachments = []
    this.projectReferences = []
    this.taskReferences = []
    this.root.props.onAttachmentsChange?.([])
    this.root.props.onProjectReferencesChange?.([])
    this.root.props.onTaskReferencesChange?.([])
    const selectedStartAfterThreads = this.root.handleDropData.startAfterEnabled
      ? this.root.handleDropData.startAfterThreads
      : []
    this.root.captureComposerRoot.clearStartAfterThreads()
    const attachedThreads = [...this.root.handleDropData.threadReferences]
    this.root.handleDropData.clearThreadContexts()
    this.root.props.onSend(
      msg,
      files,
      direct,
      taggedPaths,
      taggedTasks,
      selectedStartAfterThreads,
      attachedThreads
    )
    // The draft just left the composer, so the long-form writing surface has
    // nothing left to hold: settle back to the compact composer.
    this.root.captureComposerRoot.expansion.collapse()
  }

  handleComposerValueChange(nextValue: string): void {
    if (this.historyIndex >= 0) {
      this.historyIndex = -1
      this.savedValue = ''
    }
    const retainedReferences = this.projectReferences.filter((reference) =>
      nextValue.includes(projectReferenceToken(reference))
    )
    if (retainedReferences.length !== this.projectReferences.length) {
      this.projectReferences = retainedReferences
      this.root.props.onProjectReferencesChange?.(this.projectReferences)
    }
    const retainedTaskReferences = this.taskReferences.filter((reference) =>
      nextValue.includes(taskReferenceToken(reference))
    )
    if (retainedTaskReferences.length !== this.taskReferences.length) {
      this.taskReferences = retainedTaskReferences
      this.root.props.onTaskReferencesChange?.(this.taskReferences)
    }
    this.root.props.onValueChange?.(nextValue)
  }

  handleCaretTextChange(textBeforeCaret: string, supportsCommands: boolean): void {
    if (
      textBeforeCaret === this.lastCaretText &&
      supportsCommands === this.root.captureComposerRoot.lastCaretSupportsCommands
    ) {
      return
    }
    this.lastCaretText = textBeforeCaret
    this.root.captureComposerRoot.lastCaretSupportsCommands = supportsCommands
    const mentionStart = supportsCommands
      ? composerMentionStart(textBeforeCaret, { allowSpaces: this.mentionSpansSpaces })
      : null
    if (mentionStart === null || mentionStart !== this.dismissedMentionStart) {
      this.dismissedMentionStart = null
    }
    if (this.dismissedMentionStart === null) {
      this.mentions.schedule(supportsCommands ? textBeforeCaret : '')
    } else {
      this.mentions.open = false
    }
    const slashMatch = supportsCommands ? /(^|\s)\/([^\s/]*)$/u.exec(textBeforeCaret) : null
    this.slashOpen = Boolean(slashMatch)
    this.slashQuery = slashMatch?.[2] ?? ''
    this.slashIndex = 0
    // A query that matches no actions is almost certainly a path being typed
    // (e.g. `cd /usr/local/bin`), not a command   close the menu so Enter and
    // the rest of the text behave normally.
    if (this.slashOpen && this.slashActions.length === 0) {
      this.slashOpen = false
    }
  }

  /**
   * Rewrite the `@` tags a send was typed with but never picked from the
   * dropdown. The mention search owns the matching; the composer only applies
   * the resolved text and the references it returns, so a send targets the same
   * file or built-in tag a dropdown pick would have produced.
   */
  async resolveTypedTargetsIntoDraft(): Promise<void> {
    const draft = this.value
    const resolved = await this.mentions.resolveTypedTargets(draft, this.projectReferences)
    // A keystroke that landed during the lookup owns a newer draft than the one
    // resolved against; never overwrite what the user has since typed.
    if (this.value !== draft) return
    if (resolved.text !== this.value) {
      this.value = resolved.text
      this.root.props.onValueChange?.(this.value)
    }
    if (resolved.references.length > 0) {
      this.projectReferences = [...this.projectReferences, ...resolved.references]
      this.root.props.onProjectReferencesChange?.(this.projectReferences)
    }
  }

  /**
   * The pattern that swaps the mention being typed for a picked token.
   *
   * It matches the query the caret is really in, so a thread title typed with
   * its spaces is replaced as one mention instead of being left in the draft
   * beside the token the pick inserts.
   */
  mentionReplacePattern(): RegExp {
    return composerMentionReplacePattern(this.lastCaretText ?? this.value, {
      allowSpaces: this.mentionSpansSpaces
    })
  }

  selectMention(mention: ComposerMentionEntry): void {
    this.mentions.open = false
    if (mention.type === 'utility') {
      const token = `${mention.entry.token} `
      const inserted = this.editor.replaceTextBeforeCaret(
        this.mentionReplacePattern(),
        (_match, prefix) => `${prefix}${token}`
      )
      if (!inserted) {
        this.value = this.value.replace(this.mentionReplacePattern(), (_, prefix: string) => {
          return `${prefix}${token}`
        })
        this.root.props.onValueChange?.(this.value)
      }
      return
    }
    if (mention.type === 'task') {
      this.selectTaskMention(mention.entry)
      return
    }
    if (mention.type === 'assistant') {
      const token = `${composerAssistantTagToken(mention.entry)} `
      const inserted = this.editor.replaceTextBeforeCaret(
        this.mentionReplacePattern(),
        (_match, prefix) => `${prefix}${token}`
      )
      if (!inserted) {
        this.value = this.value.replace(this.mentionReplacePattern(), (_, prefix: string) => {
          return `${prefix}${token}`
        })
        this.root.props.onValueChange?.(this.value)
      }
      return
    }
    const entry = mention.entry
    const existingReference = this.projectReferences.find(
      (reference) => reference.path === entry.path
    )
    if (!existingReference && this.projectReferences.length >= 20) return
    const reference: PromptProjectReference = {
      id: crypto.randomUUID(),
      name: entry.name,
      path: entry.path,
      kind: entry.kind
    }
    if (!existingReference) {
      this.projectReferences = [...this.projectReferences, reference]
      this.root.props.onProjectReferencesChange?.(this.projectReferences)
    }
    const inserted = this.editor.replaceTextBeforeCaret(
      this.mentionReplacePattern(),
      (_match, prefix) => `${prefix}${projectReferenceToken(reference)} `
    )
    if (!inserted) {
      this.value = this.value.replace(this.mentionReplacePattern(), (_, prefix: string) => {
        return `${prefix}${projectReferenceToken(reference)} `
      })
      this.root.props.onValueChange?.(this.value)
    }
    if (inserted) return
    void tick().then(() => {
      const editor = document.getElementById(this.composerEditorId)
      if (!(editor instanceof HTMLDivElement)) return
      editor.focus()
      placeCaretAtEnd(editor)
    })
  }

  selectTaskMention(task: AssignmentTask): void {
    if (!this.root.props.assignmentId) return
    const existingReference = this.taskReferences.find((reference) => reference.taskId === task.id)
    if (!existingReference && this.taskReferences.length >= 20) return
    const reference: PromptAssignmentTaskReference = {
      assignmentId: this.root.props.assignmentId,
      taskId: task.id,
      phaseId: task.phaseId,
      title: task.title,
      description: task.description,
      status: task.status,
      workerName: task.workerName ?? (task.owner === 'senior' ? 'Sr. Engineer' : undefined),
      threadId: task.threadId
    }
    if (!existingReference) {
      this.taskReferences = [...this.taskReferences, reference]
      this.root.props.onTaskReferencesChange?.(this.taskReferences)
    }
    const inserted = this.editor.replaceTextBeforeCaret(
      this.mentionReplacePattern(),
      (_match, prefix) => `${prefix}${taskReferenceToken(reference)} `
    )
    if (!inserted) {
      this.value = this.value.replace(this.mentionReplacePattern(), (_, prefix: string) => {
        return `${prefix}${taskReferenceToken(reference)} `
      })
      this.root.props.onValueChange?.(this.value)
    }
    if (inserted) return
    void tick().then(this.root.captureComposerRoot.focusComposerAtEnd)
  }

  /** Attach files that arrived through a path the composer has already built
   *  them on, applying the same duplicate guard and file ceiling as a drop. */
  adoptAttachments(candidates: readonly PromptAttachment[]): PromptAttachment[] {
    if (candidates.length === 0) return []
    // Dropping the same file twice must leave one chip: a repeated `file://` URL
    // is a duplicate key in the keyed attachment list and throws at render time.
    const { added, duplicates, overflow } = partitionNewAttachments(this.attachments, candidates)
    if (duplicates.length > 0) this.root.captureComposerRoot.noticeDuplicateAttachments(duplicates)
    this.root.captureComposerRoot.noticeOverflowAttachments(overflow)
    if (added.length === 0) return []
    this.attachments = [...this.attachments, ...added]
    this.root.props.onAttachmentsChange?.([...this.attachments])
    return added
  }

  removeAttachment(index: number): void {
    const removed = this.attachments[index]
    if (removed) this.root.handleDropData.preview.clear(removed.url)
    this.attachments = this.attachments.filter((_, i) => i !== index)
    this.root.props.onAttachmentsChange?.(this.attachments)
  }

  keydownContext: ComposerKeydownContext = {
    isMentionOpen: () => this.mentions.open,
    getMentionEntries: () => this.mentions.entries,
    getMentionIndex: () => this.mentions.index,
    setMentionIndex: (index) => (this.mentions.index = index),
    closeMentions: () => {
      // Escape dismisses the suggestions for the token being typed, so the
      // menu does not spring back while the user finishes that tag by hand.
      this.dismissedMentionStart =
        this.lastCaretText === null
          ? null
          : composerMentionStart(this.lastCaretText, { allowSpaces: this.mentionSpansSpaces })
      this.mentions.open = false
    },
    selectMention: this.selectMention,
    isSlashOpen: () => this.slashOpen,
    closeSlash: () => (this.slashOpen = false),
    getSlashActions: () => this.slashActions,
    getSlashIndex: () => this.slashIndex,
    setSlashIndex: (index) => (this.slashIndex = index),
    selectSlashAction: this.selectSlashAction,
    isSelectionPopoverOpen: () => this.root.captureComposerRoot.selectionPopoverOpen,
    closeSelectionPopover: () => (this.root.captureComposerRoot.selectionPopoverOpen = false),
    isStartAfterPopoverOpen: () => this.root.captureComposerRoot.startAfterPopoverOpen,
    closeStartAfterPopover: () => this.root.captureComposerRoot.closeStartAfterPopover(),
    getComposerElement: () => document.getElementById(this.composerEditorId),
    getHistoryIndex: () => this.historyIndex,
    setHistoryIndex: (index) => (this.historyIndex = index),
    getSavedValue: () => this.savedValue,
    setSavedValue: (next) => (this.savedValue = next),
    getValue: () => this.value,
    setValue: (next) => (this.value = next),
    getHistoryMessages: () => this.root.props.historyMessages,
    onHistoryNavigateStart: () => this.root.props.onHistoryNavigateStart?.(),
    onValueChange: (next) => this.root.props.onValueChange?.(next),
    getShowEngineeringMode: () => this.root.props.showEngineeringMode,
    openEngineeringToolbox: () =>
      void this.root.captureComposerRoot.engineeringToolbox?.openAndFocus(),
    getWorking: () => this.root.props.working,
    hasStop: () => Boolean(this.root.props.onStop),
    confirmStop: this.confirmStop,
    isPendingStop: () => this.pendingStop,
    cancelStop: this.cancelStop
  }
}
