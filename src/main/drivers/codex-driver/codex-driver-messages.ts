import type { AgentMessage } from '../../../lib/types'
import { normalizeAppServerItem } from '../codex/codex-tools'
import { recordValue } from '../codex/codex-values'
import { parseItem } from '../codex/codex-stream-fold'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver messages: one concern, moved verbatim from the composition root. */
export class CodexDriverMessages {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  /**
   * Codex item ids are only unique within a Codex thread, so every id is
   * namespaced with the CodeInOven session when parsed. Normalize native item
   * ids on read and collapse duplicate ids a resumed thread can produce.
   */
  async loadMessages(projectPath: string, sessionId: string): Promise<AgentMessage[]> {
    try {
      const messages = await this.host.base.superLoadMessages(projectPath, sessionId)
      return this.host.units['sessions'].normalizeSessionMessages(messages, sessionId)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('CLI session is unavailable:')) {
        throw error
      }
      return this.loadNativeThreadMessages(projectPath, sessionId)
    }
  }

  async loadMessagesSince(
    projectPath: string,
    sessionId: string,
    messageId: string
  ): Promise<AgentMessage[]> {
    try {
      const messages = await this.host.base.superLoadMessagesSince(
        projectPath,
        sessionId,
        messageId
      )
      return this.host.units['sessions'].normalizeSessionMessages(messages, sessionId)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('CLI session is unavailable:')) {
        throw error
      }
      const messages = await this.loadNativeThreadMessages(projectPath, sessionId)
      const startIndex = messages.findLastIndex((message) => message.id === messageId)
      return startIndex >= 0 ? messages.slice(startIndex) : messages
    }
  }

  async loadNativeThreadMessages(
    projectPath: string,
    nativeThreadId: string
  ): Promise<AgentMessage[]> {
    const host = await this.host.units['runtime'].ensureAppServerHost(projectPath)
    const result = await this.host.units['runtime'].appServerRequest(host, 'thread/read', {
      threadId: nativeThreadId,
      includeTurns: true
    })
    const thread = recordValue(result['thread']) ?? result
    const turns = Array.isArray(thread['turns']) ? thread['turns'] : []
    const messages: AgentMessage[] = []
    for (const turnValue of turns) {
      const turn = recordValue(turnValue)
      const items = turn && Array.isArray(turn['items']) ? turn['items'] : []
      for (const itemValue of items) {
        const item = normalizeAppServerItem(recordValue(itemValue))
        if (!item) continue
        const parsed = parseItem(item, true, nativeThreadId)
        if (parsed?.messages) messages.push(...parsed.messages)
      }
    }
    return this.host.units['sessions']
      .normalizeSessionMessages(messages, nativeThreadId)
      .map((message) => ({
        ...message,
        origin: 'subagent',
        visibility: 'subagent_trace'
      }))
  }
}
