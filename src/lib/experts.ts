import {
  DESIGN_ASSIGNMENT_OUTPUTS,
  designAssignmentIsMedia,
  designAssignmentOutput,
  designAssignmentOutputDescription,
  designAssignmentOutputLabel,
  designAssignmentOutputWork,
  designAssignmentReference,
  usableDesignAssignments
} from './design-assignments'
import type { AgentModelSelection } from './types/common'
import type { DesignAssignment, DesignAssignmentOutput } from './types/settings'
import type { SessionTagKind } from './session-tags'

/**
 * The experts a user staffed, as the surfaces that show them need to read them.
 *
 * An "expert" is the app's design assignment: one named piece of work and the
 * model the user put on it. The domain name stays `design assignment` because
 * that is what the settings, the playbook and `delegate` call it; this module is
 * the presentation of the same list, for the card a design or video session
 * shows before its first send, so the two surfaces cannot disagree about who is
 * staffed or what a mute means.
 *
 * Everything here is pure, because both processes read it: the renderer decides
 * whether to show the card, and the main process decides what the agent is told
 * and whether `delegate` will run at all.
 */

/** One expert as a card renders it: the craft, the name, and the model. */
export interface ExpertSummary {
  /** The handle the agent names in a tool call, e.g. `seo-copy`. */
  id: string
  /** The user's own name for the work, e.g. `SEO copy`. */
  label: string
  /** What the work produces, which chooses the craft's vocabulary. */
  produces: DesignAssignmentOutput
  /** The craft as a person: `Copywriter`, `Illustrator`, `Video editor`. */
  craftLabel: string
  /** The same craft as a noun, for a sentence: `copywriting`, `illustration`. */
  craftWork: string
  /** One line on what the craft delivers. */
  craftDescription: string
  /** The harness model the user assigned, for a text craft. */
  selection?: AgentModelSelection
  /** The generation model the user assigned, for a media craft. */
  mediaModel?: string
  /** The standing guidance sent with every call, trimmed. */
  instructions: string
}

/** The experts a config actually holds, ready to render. Only the usable ones. */
export function expertSummaries(
  assignments: readonly DesignAssignment[] | undefined | null
): ExpertSummary[] {
  return usableDesignAssignments({ assignments: [...(assignments ?? [])] }).map((assignment) => {
    const produces = designAssignmentOutput(assignment)
    return {
      id: assignment.id,
      label: assignment.label.trim() || assignment.id,
      produces,
      craftLabel: designAssignmentOutputLabel(produces),
      craftWork: designAssignmentOutputWork(produces),
      craftDescription: designAssignmentOutputDescription(produces),
      ...(designAssignmentIsMedia(produces)
        ? { mediaModel: assignment.mediaModel?.trim() ?? '' }
        : { selection: assignment.selection }),
      instructions: assignment.instructions?.trim() ?? ''
    }
  })
}

/**
 * A stable digest of the expert set, so a thread can tell that the list it
 * decided about is not the list it has now.
 *
 * Deterministic and dependency-free on purpose: the renderer computes it as
 * well, and a hash would mean two implementations agreeing on the same bytes.
 * The model is part of the digest because swapping the model on one craft is a
 * change the user would want to be asked about; the label is not, because
 * renaming work does not change who does it.
 */
export function expertSignature(
  assignments: readonly DesignAssignment[] | undefined | null
): string {
  return expertSummaries(assignments)
    .map((expert) =>
      [
        expert.id,
        expert.produces,
        expert.selection?.harnessId ?? '',
        expert.selection?.providerId ?? '',
        expert.selection?.modelId ?? '',
        expert.selection?.accountId ?? '',
        expert.mediaModel ?? ''
      ].join(':')
    )
    .join('|')
}

/** What a thread decided about its experts. */
export type ThreadExpertChoice = 'all' | 'off'

/** The thread's recorded answer to the expert card. */
export interface ThreadExpertDecision {
  /** Whether the thread's session may delegate to the experts. */
  choice: ThreadExpertChoice
  /**
   * Whether the user also asked not to be offered the card again in this thread.
   * `Don't use experts` sets it; `Disable for this thread` does not, so a change
   * to the expert list asks once more.
   */
  silent: boolean
  /** The expert set the decision was made against. */
  signature: string
  /** When the thread decided (ms). */
  decidedAt: number
}

/** What the card needs to know before it decides to appear. */
export interface ExpertOfferInput {
  /** The session this send opens, or the one the thread is already in. */
  session: 'none' | 'design' | 'video'
  /** How many experts the user has staffed. Zero means there is nothing to offer. */
  expertCount: number
  /** The thread's recorded decision, or null before it ever made one. */
  decision: ThreadExpertDecision | null
  /** Digest of the experts as they are right now. */
  signature: string
}

/**
 * Whether this send should be held so the user can decide about their experts.
 *
 * The card is shown while it still has a question. A thread that answered keeps
 * its answer, and the card returns only when that answer can no longer be right:
 * the user staffed a different set of experts, so the decision was made about
 * work that is no longer the work at hand. A thread that asked not to be offered
 * the card again is never asked, whatever the list says.
 */
export function shouldOfferExpertCard(input: ExpertOfferInput): boolean {
  if (input.session === 'none' || input.expertCount === 0) return false
  const decision = input.decision
  if (!decision) return true
  if (decision.silent) return false
  return decision.signature !== input.signature
}

/**
 * Which session a send belongs to: the one it opens, or the one the thread is
 * already in.
 *
 * Both count, because the question the card asks is about the session rather than
 * about the message. A user typing `@cio-design` for the first time and a user
 * sending a third message into a session they never answered for are both about
 * to have a session work with (or without) their experts.
 */
export function expertSessionFor(
  draft: SessionTagKind,
  thread: 'design' | 'video' | null
): 'none' | 'design' | 'video' {
  return draft === 'none' ? (thread ?? 'none') : draft
}

/** Whether a session started with this decision may delegate to the experts. */
export function expertsAllowed(decision: ThreadExpertDecision | null | undefined): boolean {
  return decision?.choice !== 'off'
}

/**
 * What a session can say about its experts, which is all the playbook wording
 * needs: it may delegate, none are staffed, or the user turned them off.
 *
 * The three are distinct on purpose. "No expert is staffed" tells an agent that
 * the user has not made that decision yet, so it names the work and asks; "turned
 * off for this thread" tells it the user answered, so it does the work itself and
 * stops proposing a delegation the thread has already refused.
 */
export type ExpertAvailability = 'available' | 'none-assigned' | 'muted'

export function expertAvailability(
  assignments: readonly DesignAssignment[] | undefined | null,
  decision: ThreadExpertDecision | null | undefined
): ExpertAvailability {
  if (!expertsAllowed(decision)) return 'muted'
  return expertSummaries(assignments).length > 0 ? 'available' : 'none-assigned'
}

/** The experts a session may actually delegate to, and why, when it may use none. */
export interface EffectiveExperts {
  /** Why this is what it is, which the wording of every surface is chosen from. */
  availability: ExpertAvailability
  /**
   * The assignments the session may run. Empty unless `availability` is
   * `available`, so a caller that only needs the list cannot accidentally use a
   * list the user muted.
   */
  assignments: DesignAssignment[]
}

/**
 * The one rule that turns a config and a thread's answer into what its session
 * may use. Pure, so both processes compute it the same way and neither has to
 * trust the other's copy.
 */
export function effectiveExperts(
  assignments: readonly DesignAssignment[] | undefined | null,
  decision: ThreadExpertDecision | null | undefined
): EffectiveExperts {
  const availability = expertAvailability(assignments, decision)
  return {
    availability,
    assignments:
      availability === 'available'
        ? usableDesignAssignments({ assignments: [...(assignments ?? [])] })
        : []
  }
}

/** A line naming how many experts are staffed, for a card heading. */
export function expertCountLabel(count: number): string {
  return count === 1 ? '1 expert' : `${count} experts`
}

/** The empty answer, for a caller with nothing staffed and no decision recorded. */
export const NO_EXPERTS: EffectiveExperts = { availability: 'none-assigned', assignments: [] }

/** Which session a delegation paragraph is written for. */
export type ExpertSessionKind = 'design' | 'video'

/** What each session calls the work it produces, for a sentence that names it. */
const SESSION_WORK: Readonly<Record<ExpertSessionKind, string>> = {
  design: 'the design',
  video: 'the composition'
}

/**
 * The paragraph a session's playbook carries about the models the user staffed.
 *
 * One builder for both sessions, because the question is the same one: who does
 * the work that is not markup. What differs is the noun, so both playbooks say
 * the same thing about the same list, and a design session and a video session
 * can never disagree about whether delegation is available or who answers it.
 *
 * The three availability states are deliberately distinct. `available` names the
 * list; `none-assigned` tells the agent the user has not made this decision and to
 * ask; `muted` tells it the user made it and turned it off, so it does the work
 * itself and stops proposing a delegation the thread already refused.
 */
export function expertDelegationGuidance(
  experts: EffectiveExperts,
  kind: ExpertSessionKind
): string {
  const work = SESSION_WORK[kind]
  if (experts.availability === 'muted') {
    return `The user turned the experts off for this thread, so \`delegate\` refuses here and no assigned model will run in this session. That is their decision for this thread rather than a missing setting: do the work you can with your own tools, and where ${work} genuinely needs a model, say which work needs one and that they can turn the experts back on for this thread from the design coordinator, or assign one in Settings, Design. Never choose a model yourself, and never fill the gap with a placeholder presented as the real thing.`
  }
  if (experts.availability === 'none-assigned') {
    return `No expert is assigned yet: the user has not put a model on any of the craft work ${work} needs. The experts are app-wide, so this is true of every project rather than of this one. Produce what you can with your own tools, and when ${work} needs something you cannot produce, say which work needs a model and that the user assigns one in Settings, Design. Never choose a model yourself, and never fill the gap with a placeholder presented as the real thing.`
  }
  const lines: string[] = ['The user assigned:']
  for (const output of DESIGN_ASSIGNMENT_OUTPUTS) {
    const group = experts.assignments.filter(
      (assignment) => designAssignmentOutput(assignment) === output
    )
    if (group.length === 0) continue
    const named = group.map(designAssignmentReference).join(', ')
    lines.push(
      output === 'text'
        ? `- ${designAssignmentOutputLabel(output)}, run with \`delegate\`: ${named}.`
        : `- ${designAssignmentOutputLabel(output)}, produced with a generation capability: ${named}.`
    )
  }
  lines.push(
    '',
    "`delegate` answers with text, so it runs the copywriting work. A picture, a clip or a track is a file rather than an answer, so it comes from a generation capability in the app's utilities bank, and the model listed against that craft is the one the user had in mind: prefer a capability that reaches it, say which one you used, and save what it returns with `save-media`, because a generation link expires and the saved file does not. When no capability is installed, name the one that is needed and the model the user already chose. Two assignments that cover the same craft are the user's own alternatives, and `delegate` tries them in the user's order and reports which one answered. When the work is not in that list at all, do not pick a model yourself: name the work and tell the user to assign a model to it in Settings, Design."
  )
  return lines.join('\n')
}
