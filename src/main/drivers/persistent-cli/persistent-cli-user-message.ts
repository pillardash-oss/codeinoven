import { generateId } from '../../../lib/utils'
import type { AgentMessage, AgentPart } from '../../../lib/types'
import type { SendPromptOptions } from '../driver.interface'

/**
 * Build the user message for a logical turn, honoring any stateless-steer
 * payload override that was registered for the message id.
 */
export function buildUserMessage(
  outboundOverrides: Map<string, Pick<SendPromptOptions, 'text' | 'attachments'>>,
  opts: Pick<SendPromptOptions, 'text' | 'attachments' | 'userMessageId'>
): AgentMessage {
  const userMessageId = opts.userMessageId ?? generateId()
  const publicPayload = outboundOverrides.get(userMessageId) ?? opts
  outboundOverrides.delete(userMessageId)
  const userParts: AgentPart[] = [
    {
      type: 'text',
      id: `${userMessageId}:text`,
      messageID: userMessageId,
      text: publicPayload.text
    },
    ...publicPayload.attachments.map((attachment, index): AgentPart => ({
      type: 'file',
      id: `${userMessageId}:file:${index}`,
      messageID: userMessageId,
      mime: attachment.mime,
      url: attachment.url,
      filename: attachment.filename
    }))
  ]
  return {
    id: userMessageId,
    role: 'user',
    parts: userParts,
    createdAt: Date.now(),
    completedAt: Date.now()
  }
}
