/**
 * What the "New assistant" control hands back.
 *
 * The name and the personality are the two things only the user can state about
 * an assistant; the schedule's name is optional and only meaningful while the
 * assistant runs on a clock. Everything else the assistant gathers in its own
 * Getting started conversation.
 */
export interface NewAssistantDraft {
  name: string
  personality: string
  scheduled: boolean
  scheduleName: string
}
