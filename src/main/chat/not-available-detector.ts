/**
 * Detect an unavailable MCP, skill, or app utility at the tool-call boundary
 * and, much more tightly, in final assistant prose. The chat engine uses the
 * tool-call detector only when a tool call has already failed, so direct
 * utility use is never interrupted; the prose detector is precision-first and
 * bounded (see concludesCapabilityUnavailable).
 */

/** Capability markers that can identify an app-managed tool call. */
const TOOL_CAPABILITY =
  /(?:mcp|skills?|utilit(?:y|ies)|plugins?|extensions?|computer[\s_-]?use|image[\s_-]?descriptor)/iu

/** Provider/harness wording that indicates the requested tool could not be used. */
const UNAVAILABLE_TOOL_FAILURE =
  /(?:not found|unavailable|not available|does(?:n'?t| not) exist|not installed|cannot be found|could not be found|unknown (?:mcp|skill|utility|plugin|extension|tool))/iu

export interface CapabilityUnavailableClaim {
  /** The exact availability failure wording reported by the tool call. */
  phrase: string
  /** The capability marker that should guide the utility search. */
  target: string
  /** Bounded tool-call evidence used to build the internal steering prompt. */
  evidence: string
}

/**
 * Return an unavailable-capability claim only for a failed tool call that
 * names an MCP/skill/utility-like capability. A generic file or shell failure
 * therefore cannot trigger a utility-search nudge.
 */
export function detectUnavailableToolCall(
  toolName: string,
  toolError: string
): CapabilityUnavailableClaim | null {
  const name = toolName.trim()
  const error = toolError.trim()
  if (!name || !error) return null
  const failure = error.match(UNAVAILABLE_TOOL_FAILURE)
  if (!failure) return null
  const capability = `${name} ${error}`.match(TOOL_CAPABILITY)
  if (!capability) return null
  return {
    phrase: failure[0],
    target: capability[0],
    evidence: `${name}: ${error}`.slice(0, 1_500)
  }
}

/**
 * Prose-level detection is deliberately much tighter than the tool-call one.
 * An earlier broad prose scanner (removed in cca98f43) produced false
 * positives, so this one only accepts narrow, high-confidence availability
 * conclusions: tool-shaped capability nouns (no models/providers/APIs/SDKs —
 * those drove the old false positives), sentence-scoped with the noun and the
 * denial phrase near each other, a session-context qualifier for copula and
 * "no <noun>" forms, artifact-noun and requirement-qualifier guards, and a
 * strictly personal "I/we don't have" form for possession denials.
 */

/** Tool-shaped capability nouns that appear in harness availability claims. */
const CAPABILITY_NOUN =
  /\b(?:mcp(?:\s+servers?)?|skills?|tools?|utilit(?:y|ies)|plugins?|extensions?|computer[\s_-]?use)\b/giu

/** The claim must be about this session/harness, not about app features. */
const SESSION_CONTEXT =
  /\bin (?:this|the current) (?:session|conversation|environment|context|chat|thread|workspace|harness|runtime)\b/iu

/**
 * Copula denial: "<noun> ... is/are n't available|accessible|installed|..." or
 * a bare "unavailable" near the noun.
 */
const AVAILABILITY_DENIAL =
  /\b(?:are|is|was|were)\s*(?:n'?t|not)\s+(?:currently\s+|directly\s+)?(?:available|accessible|installed|supported|exposed|provided|present|enabled|offered|configured|usable)\b|\bunavailable\b/giu

/**
 * Possession denial: a strictly first-person "I/we don't have" anchor. The
 * pronoun keeps ordinary descriptive prose ("the app doesn't have X") out.
 */
const POSSESSION_DENIAL = /\b(?:I|we)\s+(?:don'?t|do\s+not)\s+have\b/iu

/** Absence denial: "no <noun>" (optionally with a filler qualifier). */
const ABSENCE_DENIAL = /\bno\s+(?:currently\s+|directly\s+|such\s+)?(?:mcp(?:\s+servers?)?|skills?|tools?|utilit(?:y|ies)|plugins?|extensions?|computer[\s_-]?use)\b/giu

/**
 * Nouns that mark the sentence as describing a project artifact rather than a
 * harness capability ("the MCP config file is not available"). When one sits
 * closer to the denial than the capability noun, the claim is skipped.
 */
const ARTIFACT_NOUN =
  /\b(?:file|files|folder|directory|config(?:uration)?|manifest|documentation|docs?|path|package|module|dependency|dependencies|repo(?:sitory)?|database|table|branch|commit|environment variable)\b/giu

/**
 * A "no <noun>" claim followed by a requirement qualifier ("no tools needed")
 * is a research or implementation finding, not a verdict that a harness
 * capability is absent.
 */
const REQUIREMENT_QUALIFIER =
  /\b(?:need|needed|require|required|necessary|depend(?:ency|encies|s)?)\b/iu

/** Maximum characters between the denial phrase and the capability noun. */
const MAX_NOUN_DISTANCE = 80

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/)
}

function nearestNounDistance(
  sentence: string,
  index: number
): { distance: number; target: string } | null {
  let best: { distance: number; target: string } | null = null
  CAPABILITY_NOUN.lastIndex = 0
  for (const match of sentence.matchAll(CAPABILITY_NOUN)) {
    const distance = Math.abs((match.index ?? 0) - index)
    if (distance > MAX_NOUN_DISTANCE) continue
    if (!best || distance < best.distance) best = { distance, target: match[0] }
  }
  return best
}

function artifactIsCloser(sentence: string, index: number, nounDistance: number): boolean {
  ARTIFACT_NOUN.lastIndex = 0
  for (const match of sentence.matchAll(ARTIFACT_NOUN)) {
    if (Math.abs((match.index ?? 0) - index) < nounDistance) return true
  }
  return false
}

interface SentenceClaim {
  phrase: string
  target: string
  evidence: string
}

function detectInSentence(sentence: string): SentenceClaim | null {
  const sessionScoped = SESSION_CONTEXT.test(sentence)

  const denials: Array<{ match: RegExpMatchArray; kind: 'availability' | 'absence' }> = []
  AVAILABILITY_DENIAL.lastIndex = 0
  for (const match of sentence.matchAll(AVAILABILITY_DENIAL)) {
    denials.push({ match, kind: 'availability' })
  }
  ABSENCE_DENIAL.lastIndex = 0
  for (const match of sentence.matchAll(ABSENCE_DENIAL)) {
    denials.push({ match, kind: 'absence' })
  }
  for (const { match, kind } of denials) {
    const index = match.index ?? 0
    if (kind === 'availability' && !sessionScoped) continue
    if (kind === 'absence' && !sessionScoped) continue
    const noun = nearestNounDistance(sentence, index)
    if (!noun) continue
    if (artifactIsCloser(sentence, index, noun.distance)) continue
    if (kind === 'absence') {
      const tail = sentence.slice(index + match[0].length, index + match[0].length + 80)
      if (REQUIREMENT_QUALIFIER.test(tail)) continue
    }
    return { phrase: match[0], target: noun.target, evidence: sentence.trim() }
  }

  POSSESSION_DENIAL.lastIndex = 0
  const possession = sentence.match(POSSESSION_DENIAL)
  if (possession && possession.index !== undefined) {
    const noun = nearestNounDistance(sentence, possession.index)
    if (noun && !artifactIsCloser(sentence, possession.index, noun.distance)) {
      return { phrase: possession[0], target: noun.target, evidence: sentence.trim() }
    }
  }
  return null
}

/**
 * Return the first sentence-local harness-availability conclusion, or null
 * when no tight claim is present. Deliberately precision-first: missing a rare
 * phrasing is acceptable; nudging on ordinary prose is not.
 */
export function concludesCapabilityUnavailable(text: string): CapabilityUnavailableClaim | null {
  if (!text) return null
  for (const sentence of splitSentences(text)) {
    const claim = detectInSentence(sentence)
    if (claim) return { phrase: claim.phrase, target: claim.target, evidence: claim.evidence }
  }
  return null
}

/** Internal steering prompt for an availability conclusion found in prose. */
export function searchNudgePromptForProse(claim: CapabilityUnavailableClaim): string {
  return [
    `Your previous answer concluded that a capability is unavailable: "${claim.phrase}" about "${claim.target}".`,
    'This is an internal correction, not a new user request. Continue answering the original user request and preserve all relevant context.',
    'You had the utility_search tool available in this session but did not use it before concluding.',
    `First search for the capability with utility_search, using a concise query derived from ${JSON.stringify(claim.evidence.slice(0, 400))}. The app may host it as an on-demand MCP, skill, utility, or service even when it is not directly available in the harness.`,
    'Only conclude that the capability does not exist in this session when the search result has notFound:true. If notFound:false, inspect the returned utilities, activate a relevant result, and use it when it helps answer the original request.',
    'Do not replace the original task with a discussion of tool availability. Update the original answer only as much as the search result requires.'
  ].join('\n\n')
}

/** Internal steering prompt for an availability failure observed on a tool call. */
export function searchNudgePromptForToolCall(
  claim: CapabilityUnavailableClaim,
  toolName: string,
  toolError: string
): string {
  const boundedToolName = toolName.slice(0, 500)
  const boundedToolError = toolError.slice(0, 1_000)
  return [
    'A tool call in the current turn reported that a requested capability is unavailable.',
    `Tool name: ${JSON.stringify(boundedToolName)}`,
    `Tool error: ${JSON.stringify(boundedToolError)}`,
    `The availability claim was "${claim.phrase}" about "${claim.target}".`,
    'This is an internal correction while the original task is still running, not a new user request. Preserve the original task and continue seamlessly.',
    `Call utility_search now to search for the requested capability, using a concise query derived from ${JSON.stringify(boundedToolName)}. The app may host it as an on-demand MCP, skill, utility, or service even when it is not directly available in the harness.`,
    'Only conclude that the capability does not exist in this session when the search result has notFound:true. If notFound:false, inspect the returned utilities, activate a relevant result, and use it when it helps answer the original request.',
    'Do not replace the original task with a discussion of tool availability. Update the original answer only as much as the search result requires.'
  ].join('\n\n')
}
