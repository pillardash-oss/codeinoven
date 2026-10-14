/**
 * How a plain delegating request should be carried out.
 *
 * CodeInOven gives a thread two ways to hand work off. The coordinator can spawn
 * short-lived sub-agents inside its own turn (`cio_spawn_agent`), or it can build
 * a reviewable Assignment whose tasks become durable worker threads the user can
 * watch and sign off. The two are not interchangeable: the Assignment route is
 * the one the user asked for when they say "create an assignment" or "assign this
 * to workers", and the sub-agent route is the explicit opt-out they ask for when
 * they name sub-agents directly.
 *
 * This module owns only the reading of a user's intent from their own words. It
 * is deliberately pure and free of runtime imports so the main process, a
 * renderer, or a test can all reach the same answer.
 */

/** Which delegation mechanism a user message asks for. */
export type DelegationIntent = 'assignment' | 'sub-agents' | 'none'

/**
 * Explicit sub-agent vocabulary. A message that names sub-agents is asking for
 * the inline delegation it already had, so this vocabulary is the opt-out and it
 * takes precedence when a message mentions both mechanisms.
 */
const SUB_AGENT_PATTERNS: readonly RegExp[] = [
  /\bsub[-\s]?agents?\b/iu,
  /\bspawn\s+(?:some\s+|a\s+|an\s+|the\s+)?agents?\b/iu,
  /\bcio[_\s-]?spawn[_\s-]?agent\b/iu
]

/**
 * Assignment and worker vocabulary. Each pattern requires a delegation context
 * around the word rather than the bare word, so a sentence that merely mentions
 * an Assignment or a worker ("the worker failed", "the assignment is stale")
 * does not masquerade as a request to create one.
 */
const ASSIGNMENT_PATTERNS: readonly RegExp[] = [
  // A creation or transformation verb joined to the word "assignment":
  // "create an assignment", "turn this into an assignment", "separate assignment".
  /\b(?:create|creating|creates|created|make|making|makes|generate|generating|generates|start|starting|starts|build|building|builds|prepare|preparing|prepares|draft|drafting|drafts|write|writing|writes|add|adding|adds|formulate|formulating|turn|turning|convert|converting|split|splitting|break|breaking|divide|dividing|decompose|decomposing|new|another|separate|own)\b[^.!?\n]{0,48}\bassignment\b/iu,
  // The reverse order: "an assignment for this", "assignment covering the work".
  /\bassignment\b[^.!?\n]{0,48}\b(?:for|from|based on|covering|of)\b/iu,
  // Assigning or handing work to workers.
  /\bassign(?:ed|ing|s)?\b[^.!?\n]{0,48}\bworkers?\b/iu,
  // "use workers", "hand this to workers", "delegate to workers", "split ... workers".
  /\b(?:use|using|uses|hand|handing|hands|give|giving|gives|route|routing|routes|offload|offloading|offloads|delegate|delegating|delegates|distribute|distributing|distributes|farm|farming|farms|split|splitting|splits|spread|spreading|spreads|share|sharing|shares)\b[^.!?\n]{0,48}\bworkers?\b/iu,
  /\bto\s+(?:the\s+)?workers?\b/iu,
  /\bworker\s+threads?\b/iu,
  // "workers handle this", "workers own these tasks".
  /\bworkers?\b[^.!?\n]{0,48}\b(?:handle|handles|do|does|own|owns|take|takes|run|runs|execute|executes|implement|implements|work on|build|builds)\b/iu
]

/**
 * Read a user message for the delegation mechanism it names.
 *
 * Explicit sub-agent vocabulary wins over assignment vocabulary when both appear
 * in one message: naming sub-agents is the user overriding the default route,
 * while the assignment words can describe the work that the sub-agents then do.
 * Anything that names neither stays `none`, which leaves the turn to the
 * coordinator's ordinary judgment.
 */
export function delegationIntent(text: string): DelegationIntent {
  if (text.trim().length === 0) return 'none'
  for (const pattern of SUB_AGENT_PATTERNS) {
    if (pattern.test(text)) return 'sub-agents'
  }
  for (const pattern of ASSIGNMENT_PATTERNS) {
    if (pattern.test(text)) return 'assignment'
  }
  return 'none'
}
