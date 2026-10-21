import type { Project, PromptAttachment, ThreadSettings } from '$shared/types'

/**
 * One request for an agent to take something on, opened from anywhere in the
 * app.
 *
 * Every "with agent" control used to build its own thread and hand the user an
 * unsent draft, so the same decision was re-made in a dozen places with a dozen
 * behaviours. A request carries only what this surface knows (the brief, the
 * scope it is attached to) and leaves the run configuration, the checkout and
 * the delivery to the shared dialog and runner.
 */
export type AgentAssistDelivery = 'immediate' | 'draft'

/** The configuration the user confirmed in the setup dialog. */
export interface AgentAssistSelection {
  settings: ThreadSettings
  /** Bucket to run in; null means a fresh isolated checkout is created first. */
  scopeBucketId: string | null
}

/** What a handoff built: the thread plus the message it is meant to carry. */
export interface AgentAssistPrepared {
  threadId: string
  text: string
  attachments?: PromptAttachment[]
}

/** The setup dialog's own record of one request. */
export interface AgentAssistRequest {
  projectId: string
  /** Panel heading, e.g. "Review PR #231 with agent". */
  title: string
  /** One line naming what the agent will be asked to do. */
  summary: string
  /**
   * Scope the dialog opens on. Null preselects the fresh checkout offered by
   * `newCheckout`; `scopeLocked` keeps the action on this exact checkout.
   */
  scopeBucketId: string | null
  /** Keep the scope out of the picker: the action must run in that checkout. */
  scopeLocked?: boolean
  /** The isolated checkout this action can prepare instead, when it can use one. */
  newCheckout?: {
    /** Scope name and branch base for the new checkout. */
    title: string
    /** Fork the checkout from this pull request's head instead of a branch. */
    pullRequest?: { number: number; remote: string }
  }
  /**
   * Builds the thread and its brief once the scope exists.
   *
   * Runs after the dialog is confirmed and after a requested checkout has been
   * created, so the scope id it receives is always usable. Throwing here is the
   * only way to tell the user the handoff failed, so a surface that refuses the
   * request must throw rather than return nothing.
   */
  prepare: (input: {
    scopeBucketId: string
    settings: ThreadSettings
    project: Project
  }) => Promise<AgentAssistPrepared>
}

class AgentAssistStore {
  /** The request whose setup dialog is open, if any. */
  request = $state<AgentAssistRequest | null>(null)

  open(request: AgentAssistRequest): void {
    this.request = request
  }

  close(): void {
    this.request = null
  }
}

export const agentAssist = new AgentAssistStore()
