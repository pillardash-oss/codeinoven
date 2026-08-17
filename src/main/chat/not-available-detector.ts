/**
 * Detect when an agent's final answer concludes that a capability, tool, or
 * MCP "does not exist" / "is not available", even though the app may host it
 * as an on-demand utility reachable through `utility_search`. The chat engine
 * uses this to nudge the agent into searching before it concludes.
 */

/** A capability-like noun that must appear near the negative claim. */
const CAPABILITY_TERM =
  '(?:mcp(?:s|\\s+servers?)?|skills?|tools?|extensions?|plugins?|capabilities?|providers?|models?|harness(?:es)?|utilities?|integrations?|apis?|sdks?|agents?|add-ons?)'
const CAPABILITY_NOUN = new RegExp(`\\b${CAPABILITY_TERM}\\b`, 'giu')

/** Phrasings that assert a capability is absent or unsupported. */
const NEGATIVE_CLAIM = new RegExp(
  [
    String.raw`does(?:n'?t| not) exist`,
    String.raw`is(?:n'?t| not) (?:directly )?(?:available|installed|present|supported|accessible|bundled|included|configured|here)`,
    String.raw`(?:is )?(?:not available|not directly available|unavailable|not installed|not present|not supported|not accessible|not configured|missing)`,
    String.raw`(?:cannot|can not|can't|could not|couldn't) (?:be )?found`,
    String.raw`not found`,
    String.raw`no such (?:thing|feature|capability|integration|tool|mcp|skill)s?`,
    String.raw`(?:there is|there's|there are|has|have) no\b`,
    String.raw`\bno\s+(?:(?:available|installed|configured|enabled)\s+)?${CAPABILITY_TERM}`,
    String.raw`lacks\b`
  ].join('|'),
  'giu'
)

/**
 * Words that indicate the "no X" phrasing is about implementation requirements
 * or research findings ("no SDK dependency needed") rather than a harness
 * capability being absent. When one appears right after a claim, the claim is
 * not treated as a "capability is unavailable" conclusion.
 */
const REQUIREMENT_QUALIFIER =
  /\b(?:need|needed|require|required|necessary|necessit|depend(?:ency|encies|s)?|we don'?t need|no longer)\b/iu

/** Characters of context scanned around a negative claim for a capability noun. */
const CONTEXT_WINDOW = 180

/** A capability noun that is actually describing a project artifact, not a utility. */
const ARTIFACT_NOUN =
  /\b(?:file|folder|directory|config(?:uration)?|manifest|documentation|docs?|path|package|module|dependency|dependencies)\b/giu

export interface CapabilityUnavailableClaim {
  /** The exact negative wording that was detected. */
  phrase: string
  /** The capability noun that should become the search query. */
  target: string
  /** The sentence-local evidence used to make the decision. */
  evidence: string
}

function sentenceBounds(text: string, index: number, length: number): [number, number] {
  const startCandidates = [
    text.lastIndexOf('.', index - 1),
    text.lastIndexOf('!', index - 1),
    text.lastIndexOf('?', index - 1),
    text.lastIndexOf('\n', index - 1)
  ]
  const nearestStart = Math.max(...startCandidates)
  const start =
    nearestStart >= index - CONTEXT_WINDOW ? nearestStart + 1 : Math.max(0, index - CONTEXT_WINDOW)

  const endCandidates = [
    text.indexOf('.', index + length),
    text.indexOf('!', index + length),
    text.indexOf('?', index + length),
    text.indexOf('\n', index + length)
  ].filter((candidate) => candidate >= 0)
  const nearestEnd = Math.min(...endCandidates, text.length)
  const end =
    nearestEnd <= index + length + CONTEXT_WINDOW
      ? nearestEnd
      : Math.min(text.length, index + length + CONTEXT_WINDOW)
  return [start, end]
}

function nearestCapability(
  text: string,
  contextStart: number,
  contextEnd: number,
  claimIndex: number
): { target: string; index: number } | null {
  const context = text.slice(contextStart, contextEnd)
  const candidates = [...context.matchAll(CAPABILITY_NOUN)]
    .map((match) => ({
      target: match[0],
      index: contextStart + (match.index ?? 0),
      distance: Math.abs(contextStart + (match.index ?? 0) - claimIndex)
    }))
    .filter(({ distance }) => distance <= CONTEXT_WINDOW / 2)
    .sort((left, right) => left.distance - right.distance)
  const candidate = candidates[0]
  return candidate ? { target: candidate.target, index: candidate.index } : null
}

/**
 * Return the first sentence-local capability-unavailability claim, or null
 * when no such conclusion is present. Plurals are intentional: "skills",
 * "MCPs", and "utilities" are common forms in agent answers. The
 * sentence-local capability guard keeps unrelated prose (for example, "the
 * config file was not found") from triggering a nudge.
 */
export function concludesCapabilityUnavailable(text: string): CapabilityUnavailableClaim | null {
  if (!text) return null
  for (const match of text.matchAll(NEGATIVE_CLAIM)) {
    const index = match.index ?? 0
    const [start, end] = sentenceBounds(text, index, match[0].length)
    const capability = nearestCapability(text, start, end, index)
    if (!capability) continue

    const sentence = text.slice(start, end).trim()
    const artifactDistance = Math.min(
      ...[...sentence.matchAll(ARTIFACT_NOUN)].map((artifact) =>
        Math.abs(start + (artifact.index ?? 0) - capability.index)
      ),
      Number.POSITIVE_INFINITY
    )
    if (artifactDistance <= CONTEXT_WINDOW / 3) continue

    // A "no <capability>" claim followed by a requirement qualifier ("no SDK
    // dependency needed", "no tool required") is a research/implementation
    // finding, not a verdict that a harness capability is absent. Skip it.
    // Only "no"-form claims get this check; "is not available", "does not
    // exist", "missing", etc. always count.
    if (/\b(?:there is no|there's no|there are no|has no|lacks|no such)\b/iu.test(match[0])) {
      const tail = text.slice(index + match[0].length, index + match[0].length + 80)
      REQUIREMENT_QUALIFIER.lastIndex = 0
      if (REQUIREMENT_QUALIFIER.test(tail)) continue
    }
    if (/\bno\b/iu.test(match[0])) {
      const tail = text.slice(index + match[0].length, index + match[0].length + 80)
      REQUIREMENT_QUALIFIER.lastIndex = 0
      if (REQUIREMENT_QUALIFIER.test(tail)) continue
    }
    return {
      phrase: match[0],
      target: capability.target,
      evidence: sentence
    }
  }
  return null
}

/** Internal continuation prompt that nudges the agent to search before concluding. */
export function searchNudgePrompt(claim: CapabilityUnavailableClaim): string {
  return [
    `Your previous answer contained the availability claim "${claim.phrase}" about "${claim.target}".`,
    'This is an internal correction, not a new user request. Continue answering the original user request and preserve all relevant context.',
    'You had the utility_search tool available in this session but did not use it before concluding.',
    `First search for "${claim.target}" with utility_search. The app may host it as an on-demand MCP, skill, utility, or service even when it is not directly available in the harness.`,
    'Only conclude that the capability does not exist in this session when the search result has notFound:true. If notFound:false, inspect the returned utilities, activate a relevant result, and use it when it helps answer the original request.',
    'Do not replace the original task with a discussion of tool availability. Update the original answer only as much as the search result requires.'
  ].join('\n\n')
}
