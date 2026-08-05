import type { PromptAttachment } from '$shared/types'

/**
 * Transient handoff for a freshly started standalone chat.
 *
 * The chats composer sets `message` right before selecting the newly created
 * thread; `ThreadView` consumes (and clears) it on mount so the first user
 * message flows straight into the agent without re-typing.
 */
export const chatDraft: { message: string; attachments: PromptAttachment[] } = {
  message: "",
  attachments: []
};
