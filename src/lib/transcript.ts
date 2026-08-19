import type { AgentMessage, AgentPart } from './types'

/** Options controlling how a conversation transcript is serialized. */
export interface TranscriptExportOptions {
  /**
   * Whether the working trace (reasoning, tool calls, sub-agents) should be
   * included alongside the user/agent messages. Off by default so transcripts
   * contain only the message and final output.
   */
  includeTrace: boolean
}

const USER_HEADING = '### User:'
const SEPARATOR = '---'
const AGENT_HEADING = '### Agent:'

/** Plain text of the requested presentation or the durable text parts. */
function userMessageText(msg: AgentMessage): string {
  const presentation = msg.parts.find(
    (part): part is Extract<AgentPart, { type: 'user-presentation' }> =>
      part.type === 'user-presentation'
  )
  if (presentation)
    return [presentation.presentation.action, presentation.presentation.body]
      .filter(Boolean)
      .join('\n\n')
  return msg.parts
    .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

function toolStateLabel(status: string): string {
  switch (status) {
    case 'completed':
      return 'completed'
    case 'running':
      return 'running'
    case 'error':
      return 'error'
    default:
      return 'pending'
  }
}

/** Render one working-trace part to Markdown, if it carries visible content. */
function tracePartMarkdown(part: AgentPart): string | null {
  switch (part.type) {
    case 'reasoning':
      return part.text.trim()
        ? `> **Reasoning**\n>\n${part.text
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')}`
        : null
    case 'tool': {
      const title = part.state.title ?? part.tool
      const label = toolStateLabel(part.state.status)
      const lines = [`**Tool call: ${title}** _(${label})_`]
      if (part.state.input && Object.keys(part.state.input).length > 0) {
        lines.push('', '```json', JSON.stringify(part.state.input, null, 2), '```')
      }
      if (part.state.output?.trim()) {
        const output = part.state.output.trim()
        const body = output.startsWith('```') ? output : `\`\`\`\n${output}\n\`\`\``
        lines.push('', body)
      }
      if (part.state.error?.trim()) {
        lines.push('', `> Error: ${part.state.error.trim()}`)
      }
      return lines.join('\n')
    }
    case 'subagent': {
      const label = toolStateLabel(part.activity.status)
      const lines = [
        `**Sub-agent: ${part.activity.agent}** _(${label})_\n> ${part.activity.description}`.trim()
      ]
      if (part.activity.output?.trim()) {
        lines.push('', `\`\`\`\n${part.activity.output.trim()}\n\`\`\``)
      }
      if (part.activity.error?.trim()) {
        lines.push('', `> Error: ${part.activity.error.trim()}`)
      }
      return lines.join('\n')
    }
    default:
      return null
  }
}

/** The final deliverable text of one assistant turn (last text part wins). */
function turnFinalText(assistantMessages: AgentMessage[]): string {
  let final = ''
  for (const msg of assistantMessages) {
    for (const part of msg.parts) {
      if (part.type !== 'text') continue
      if (part.phase === 'commentary') continue
      if (final) final = `${final}\n`
      final = `${final}${part.text}`
    }
  }
  return final
}

/** Every visible working-trace part belonging to one assistant turn. */
function turnTraceParts(assistantMessages: AgentMessage[]): AgentPart[] {
  const parts: AgentPart[] = []
  for (const msg of assistantMessages) {
    parts.push(...msg.parts.filter((part) => part.type !== 'text'))
  }
  return parts
}

/**
 * Serialize a conversation into a Markdown transcript.
 *
 * Each turn (a user message plus its assistant response) becomes:
 *
 * ```markdown
 * ### User:
 * <message>
 * ---
 *
 * ### Agent:
 * <response>
 * ```
 *
 * Only the message and the final output are included unless `includeTrace` is
 * set, in which case the working trace (reasoning, tool calls, sub-agents) is
 * rendered beneath the final answer.
 */
export function buildTranscriptMarkdown(
  messages: AgentMessage[],
  options: TranscriptExportOptions
): string {
  const sections: string[] = []

  let index = 0
  while (index < messages.length) {
    const msg = messages[index]
    if (msg?.role !== 'user') {
      index += 1
      continue
    }

    const userText = userMessageText(msg).trim()
    index += 1

    const assistantMessages: AgentMessage[] = []
    while (index < messages.length && messages[index]?.role === 'assistant') {
      assistantMessages.push(messages[index])
      index += 1
    }
    const finalText = turnFinalText(assistantMessages).trim()

    const block = [USER_HEADING]
    if (userText) {
      block.push(
        userText
          .split('\n')
          .map((line) => line.trimEnd())
          .join('\n')
      )
    }
    block.push(SEPARATOR, '', AGENT_HEADING)
    if (finalText) {
      block.push(
        '',
        finalText
          .split('\n')
          .map((line) => line.trimEnd())
          .join('\n')
      )
    }
    if (options.includeTrace && assistantMessages.length > 0) {
      const traceLines: string[] = []
      for (const part of turnTraceParts(assistantMessages)) {
        const rendered = tracePartMarkdown(part)
        if (rendered) traceLines.push(rendered)
      }
      if (traceLines.length > 0) {
        block.push('', '<details>', '<summary>Working trace</summary>', '')
        block.push(traceLines.join('\n\n'))
        block.push('', '</details>')
      }
    }
    sections.push(block.join('\n'))
  }

  return sections.length > 0 ? `${sections.join('\n\n')}\n` : ''
}
