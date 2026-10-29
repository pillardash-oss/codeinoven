import { type Snippet } from 'svelte'

import { type StartAfterThreadReference } from '$lib/stores/renderer-recovery.svelte'

import { type ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'
import type {
  Thread,
  ThreadSettings,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  Project,
  BrainstormSectionId,
  SpecActionIntent,
  UserMessagePresentation
} from '$shared/types'
import type { ConversationController } from '../ConversationController.svelte'

export type WorkingModelSelection = Pick<
  ThreadSettings,
  'harnessId' | 'accountId' | 'providerId' | 'modelId' | 'thinkingLevel'
>

export interface Props {
  thread: Thread
  /** True on the Chats tab   hides engineering tooling. */
  chatMode?: boolean
  /** True in Assistant View   the thread authors an assistant's knowledge. */
  assistantMode?: boolean
  /** Assistant the assistant task belongs to, when any. */
  assistantId?: string | null
  /** Assistant name, shown in the authoring head start. */
  assistantName?: string | null
  /** Whether the assistant already has a saved knowledge. */
  assistantKnowledgeComplete?: boolean
  /**
   * A run of this assistant task that another instance is streaming, when the
   * task itself is not foreign. A run executes on its own thread, so the task
   * looks idle here while its run works elsewhere; this renders that run's
   * transfer card above the composer without locking the task's own composer.
   */
  assistantForeignRunThreadId?: string | null
  /** Called with the new thread after a fork from a message succeeds. */
  onForked?: (forked: Thread) => void
  /**
   * The Assistant tab's threads (tasks, runs and Getting started conversations),
   * when this thread is one of them. Present only in Assistant View: it is what
   * puts assistants and assistant threads behind the composer's `@` menu, and
   * what names those tags once a message is sent.
   */
  assistantSpaceThreads?: Thread[]
  /**
   * Opens another Assistant tab thread, when a tagged thread in this
   * conversation is clicked.
   */
  onOpenAssistantThread?: (thread: Thread) => void
  /** Projects the chat can be continued into (visible projects only). */
  projects?: Project[]
  /** Data URLs of custom project icons, keyed by project id. */
  projectIcons?: ReadonlyMap<string, string>
  /** Called with the new thread after the chat continues in a project. */
  onContinueInProject?: (forked: Thread) => void
  /** Called after a brand-new project is added from the continue modal. */
  onProjectCreated?: (project: Project) => void | Promise<void>
  /** Promote a controller-driven temporary chat into a regular thread. */
  onContinueInThread?: () => void | Promise<void>
  /**
   * Optional conversation controller. When provided, ThreadView delegates all
   * core conversation state (messages, busy, send/steer/abort) to the
   * controller instead of threadMessages / agentRuns. Used for conversations
   * that don't follow the regular thread lifecycle, such as temporary chats.
   */
  controller?: ConversationController
  /** Optional snippet rendered at the top of the conversation surface, above
   *  the scrollable message list. Used by surfaces such as temporary chats to
   *  expose their own header actions without duplicating ThreadView internals. */
  headerSnippet?: Snippet
  /** Whether the centered composer head start may show on an empty
   *  conversation. Workspace gates this: always true in chat mode, and in
   *  project mode only for a project's sole, untouched thread. */
  allowCenteredComposer?: boolean
  /**
   * Replaces the centered empty state's heading when the conversation is about
   * something more specific than "a new chat". The browser rail's conversation
   * is the user today: it names the page the tab is on instead of greeting the
   * user like the Chats tab. Rendered inside the shared centered block, so the
   * snippet supplies only the heading and its own supporting line.
   */
  emptyStateHeading?: Snippet
  /**
   * Suggested prompts for the centered empty state, replacing the generic
   * chat/project list. Each entry has to read as something the user would send,
   * because picking one fills the composer with it.
   */
  promptSuggestions?: readonly string[]
  /**
   * The composer's placeholder once nothing more specific applies. The states
   * that describe what is happening right now (a run in flight, an assistant's
   * knowledge, a plan being prepared) all outrank it.
   */
  composerPlaceholder?: string
  /** Opens the scoped projects view with the sidebar focused on this thread
   *  (composer scope shoe   existing threads). */
  onOpenScopeView?: (thread: Thread) => void
  /** True while this thread's view is actually on screen. The workspace shell
   *  keeps a thread mounted behind Settings/Scope and other top-level views,
   *  so this   not unmount   is what tells the view the reader has left it:
   *  live polling stops and the working trace re-bounds to its newest page. */
  active?: boolean
}

/** One file part of a message the fullscreen preview can render, and whether
 *  it renders in the media lightbox or the document/text preview. */
export interface PreviewableFilePart {
  url: string
  filename: string
  mime: string
  media: boolean
}

export interface GuardedSendPayload {
  text: string
  attachments: PromptAttachment[]
  direct?: boolean
  promptContext?: string
  promptReferences: ResponseReferenceAnchor[]
  projectReferences: PromptProjectReference[]
  taskReferences: PromptAssignmentTaskReference[]
  startAfterThreads: StartAfterThreadReference[]
}

/** The entry-card park: the guarded payload plus the action intent and the
 *  user-message presentation, so the resend after a choice keeps both. */
export interface ParkedEntrySend extends GuardedSendPayload {
  specAction?: SpecActionIntent
  presentation?: UserMessagePresentation
}

export type AssignmentAuditDisplayState = Thread['auditState'] | 'failed' | 'partial'

export type StudioTemporaryChatDocument = 'brainstorm' | 'spec' | 'assignment' | 'audit'

/**
 * The cards that stack on the composer's top edge, top to bottom. Each drops
 * its own bottom rule so the surface below carries the join: another card's
 * broken top rule, or the composer's dashed one. They render flush, so the
 * whole stack reads as one surface with a broken line at every boundary.
 */
export type ComposerStackSlot =
  | 'worker'
  | 'provider'
  | 'compaction'
  | 'queued'
  | 'account'
  | 'foreign-run'
  | 'image-descriptor'
  | 'todo'

export interface BrainstormReviewAnnotationManifest {
  id: string
  section: BrainstormSectionId
  comment: string
  exactQuote: string
  range: {
    startLine?: number
    endLine?: number
    startOffset?: number
    endOffset?: number
  }
  surroundingText: { before: string; after: string }
  occurrenceCount: number
  located: boolean
}

/** A deletion awaiting confirmation, with the scope chosen in the history panel. */
export interface PendingMessageDelete {
  id: string
  content: string
  mode: 'down' | 'single' | 'up'
}
/**
 * The surface props as the units read them.
 *
 * A prop the component destructures with a default (`active = true`) is never
 * `undefined` inside the surface, so those keys are required here and lose
 * `undefined`; every other prop keeps the optionality the surface declared.
 */
export type ThreadViewSurfaceProps = {
  [
    K in
      | 'chatMode'
      | 'assistantMode'
      | 'assistantId'
      | 'assistantName'
      | 'assistantKnowledgeComplete'
      | 'assistantForeignRunThreadId'
      | 'projects'
      | 'projectIcons'
      | 'allowCenteredComposer'
      | 'active'
  ]-?: Exclude<Props[K], undefined>
} & Omit<
  Props,
  | 'chatMode'
  | 'assistantMode'
  | 'assistantId'
  | 'assistantName'
  | 'assistantKnowledgeComplete'
  | 'assistantForeignRunThreadId'
  | 'projects'
  | 'projectIcons'
  | 'allowCenteredComposer'
  | 'active'
>
