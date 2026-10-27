/**
 * How an assistant behaves, as a named section of its knowledge.
 *
 * It used to be a column of its own (`Assistant.personality`) that was carried
 * ahead of the knowledge as a separate persona layer. That made it invisible: the
 * user could only see or change it in the assistant's edit form, while every other
 * instruction lived in the behavior panel where it could be read and edited section
 * by section. It is now simply the first section of the knowledge, so the agent
 * writes it, the panel edits it like any other section, and nothing can drift
 * between two copies of the same instruction.
 *
 * The title is shared by the authoring contract, the panel and the startup
 * migration that folds a stored personality into the knowledge, so all three
 * recognise the same section.
 */

/** The section title as every surface presents it. */
export const ASSISTANT_PERSONALITY_SECTION_TITLE = 'Personality'

/** The markdown heading that opens the section in a knowledge document. */
export const ASSISTANT_PERSONALITY_HEADING = `## ${ASSISTANT_PERSONALITY_SECTION_TITLE}`

/** Ceiling for the personality a user describes, matching the knowledge section. */
export const ASSISTANT_PERSONALITY_LIMIT = 4_000

/** Whether a knowledge document already carries a personality section. */
export function hasAssistantPersonalitySection(knowledge: string): boolean {
  return /^[ \t]*(?:#{1,6}[ \t]+personality|personality)[ \t]*$/imu.test(knowledge)
}

/**
 * A knowledge document whose only content is the personality section, for an
 * assistant whose personality was stored before the section existed.
 */
export function assistantPersonalitySentence(personality: string): string {
  const text = personality.trim()
  return text ? `${ASSISTANT_PERSONALITY_HEADING}\n${text}` : ''
}
