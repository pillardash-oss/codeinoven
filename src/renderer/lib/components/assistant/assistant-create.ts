/**
 * What the "New assistant" control hands back.
 *
 * The name and the description are the two things only the user can state about an
 * assistant on a form. Everything else, including how the assistant behaves and
 * whether it runs on a clock, is agreed with the assistant itself in its Getting
 * started conversation, where it is written into the knowledge the user can then
 * edit section by section.
 */
export interface NewAssistantDraft {
  name: string
  description: string
}
