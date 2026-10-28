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
 * A markdown heading owns the text under it until the next heading, which is the
 * one rule this module exists to respect: the personality block is never dropped
 * straight onto a document that opens with prose, because that would make the whole
 * document read as one section called Personality.
 *
 * The title is shared by the authoring contract, the panel and the startup
 * migration that folds a stored personality into the knowledge, so all three
 * recognise the same section.
 */

/** The section title as every surface presents it. */
export const ASSISTANT_PERSONALITY_SECTION_TITLE = 'Personality'

/** The markdown heading that opens the section in a knowledge document. */
export const ASSISTANT_PERSONALITY_HEADING = `## ${ASSISTANT_PERSONALITY_SECTION_TITLE}`

/**
 * The heading a heading-less knowledge wears once a personality is put above it.
 *
 * A markdown heading owns everything under it until the next one, so putting the
 * personality at the top of a document that has no headings of its own would make
 * that one section the whole document: the user's instructions would read as one
 * enormous "Personality" block. The boundary heading is what keeps them apart, and
 * it is the same title the panel already gave a heading-less document.
 */
export const ASSISTANT_INSTRUCTIONS_HEADING = '## Instructions'

/** A markdown heading line: one to six `#`, then the title. */
const MARKDOWN_HEADING_LINE = /^[ \t]*#{1,6}[ \t]+\S/

/** Ceiling for the personality a user describes, matching the knowledge section. */
export const ASSISTANT_PERSONALITY_LIMIT = 4_000

/**
 * Whether a line reads as an ALL-CAPS section title, mirroring the panel's own
 * rule so the two never disagree about where a document starts.
 */
function isCapsTitleLine(line: string): boolean {
  if (line.length < 3 || line.length > 80) return false
  if (line !== line.trim()) return false
  if (/[.!?:;,]\s*$/.test(line)) return false
  if (/^[-*+]\s/.test(line) || /^\d+[.)]\s/.test(line)) return false
  const bare = line.replace(/\([^)]*\)/g, ' ')
  if (!/[A-Z]/.test(bare)) return false
  return /^[A-Z0-9 '&/.,:_-]+$/.test(bare)
}

/** Whether a knowledge opens with a heading of its own.
 *
 * A document that does can take the personality section above it without any
 * boundary, because its own first heading closes the personality block. One that
 * does not starts with prose, which would be read as part of the personality.
 */
export function startsWithKnowledgeHeading(knowledge: string): boolean {
  const first = knowledge.split('\n').find((line) => line.trim().length > 0)
  return first ? isHeadingLine(first) : false
}

/** Whether one line is a heading in either style the app recognises. */
function isHeadingLine(line: string): boolean {
  return MARKDOWN_HEADING_LINE.test(line) || isCapsTitleLine(line.trim())
}

/**
 * Whether a knowledge carries any heading at all.
 *
 * Used to tell a document that was folded properly (its own headings close the
 * personality block) apart from one a broken fold left with nothing but its
 * personality heading.
 */
export function hasKnowledgeHeading(knowledge: string): boolean {
  return knowledge.split('\n').some((line) => isHeadingLine(line))
}

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

/**
 * The `personality` section placed above an existing knowledge document.
 *
 * The document keeps every word it had. A knowledge that opens with a heading of
 * its own simply gets the personality above it; one that opens with prose (or has
 * no headings at all) gets the `Instructions` boundary heading first, so the
 * personality stays a section of its own instead of swallowing the document that
 * the user wrote.
 */
export function assistantPersonalityDocument(personality: string, knowledge: string): string {
  const block = assistantPersonalitySentence(personality)
  if (!block) return knowledge
  const body = knowledge.trim()
  if (!body) return block
  return startsWithKnowledgeHeading(body)
    ? `${block}\n\n${body}`
    : `${block}\n\n${ASSISTANT_INSTRUCTIONS_HEADING}\n${body}`
}
