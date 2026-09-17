import type { MemoryCategory, MemoryEntry, MemoryPriority, MemoryScope } from '../../../lib/types'
import { MEMORY_LIMITS, MEMORY_EXTRACTION_LIMITS } from './memory-constants'

/** Standing-preference vocabulary that makes a user turn a durable candidate. */
const STANDING_PREFERENCE_PATTERN =
  /\b(?:always|never|from now on|in future|going forward|from here on|from today|please remember|remember that|i prefer|i like|i don'?t (?:like|want)|i want you to|prefer(?: \w+){0,4} over|make sure (?:to|you)|golden rule|standing rule|general rule|reusable rule|persistent rule)\b/iu

/** Durability phrases that signal a rule should outlive the current task. */
const DURABLE_RULE_PATTERN =
  /\b(?:not a one[ -]?time|not one[ -]?off|not just (?:this|one) time|every time|each time|for every|not a single[ -]?use|ever again|from now|as a rule|one[ -]?time rule)\b/iu

const UNIVERSAL_QUANTIFIER_PATTERN = /\b(?:anything|everything|every|all)\b/iu
const DEONTIC_MODAL_PATTERN =
  /\b(?:must(?: be)?|should(?: be)?|have to be|has to be|needs? to be|required to be|ought to)\b/iu

/** Frustration/repetition signals that indicate a previously stated preference was ignored. */
const FRUSTRATION_PATTERN =
  /\b(?:again|you keep|you never|you always|you forgot|you ignore|are you (?:a fool|fool|stupid|retarded|dumb|idiot)|wtf|fuck|damn|annoying|frustrat\w*|useless|horrible|terrible|why.*(?:not.*(?:remember|propose|track|save)|waste)|i (?:told|said) you|repeatedly|already told you)\b/iu

const TRIVIAL_CONTINUATION_PATTERN =
  /^(?:ok|okay|yes|no|yep|nope|sure|fine|got it|understood|thanks|thank you|thank you!|thx|cool|nice|great|perfect|lgtm|please continue|continue|go ahead|go on|proceed)\b/iu

export interface MemoryCandidate {
  label: string
  content: string
  category: MemoryCategory
  priority: MemoryPriority
  scope: MemoryScope
}

export type MemorySkipReason = 'none' | 'no-candidate' | 'debounced' | 'over-budget'

export interface MemoryExtractionDecision {
  /** Whether a model-assisted extraction should run for this turn. */
  run: boolean
  /** Deterministic candidates extracted without a model call. */
  candidates: MemoryCandidate[]
  /** Skip reason when `run` is false. */
  reason: MemorySkipReason
  /** User text capped to local limits, safe to send to the cheap model. */
  userInput: string
  /** Assistant text capped to local limits and the token budget. */
  assistantInput: string
  /** Estimated cheap-model input tokens for this extraction. */
  inputTokens: number
}

/** Estimated token count (~4 characters per token) for auxiliary accounting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function capText(text: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return ''
  return text.length > maxCharacters ? text.slice(0, maxCharacters) : text
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase()
}

function hasFrustrationSignal(message: string): boolean {
  return FRUSTRATION_PATTERN.test(message)
}

function hasUniversalDeonticSignal(message: string): boolean {
  const sentences = message.split(/(?<=[.!?])\s+/u)
  for (const sentence of sentences) {
    if (UNIVERSAL_QUANTIFIER_PATTERN.test(sentence) && DEONTIC_MODAL_PATTERN.test(sentence))
      return true
  }
  return UNIVERSAL_QUANTIFIER_PATTERN.test(message) && DEONTIC_MODAL_PATTERN.test(message)
}

function hasDurableSignal(message: string): boolean {
  return (
    STANDING_PREFERENCE_PATTERN.test(message) ||
    DURABLE_RULE_PATTERN.test(message) ||
    hasUniversalDeonticSignal(message)
  )
}

function hasRuleLikeContent(message: string): boolean {
  return (
    hasDurableSignal(message) ||
    DEONTIC_MODAL_PATTERN.test(message) ||
    /\b(?:never|always|must|should|need to|required)\b/iu.test(message)
  )
}

function isTrivialUserTurn(message: string): boolean {
  const trimmed = message.trim()
  if (trimmed.length === 0) return true
  if (hasFrustrationSignal(trimmed)) return false
  if (trimmed.length < 15) return true
  if (trimmed.endsWith('?') && !hasDurableSignal(trimmed) && !hasFrustrationSignal(trimmed))
    return true
  return TRIVIAL_CONTINUATION_PATTERN.test(trimmed)
}

function categoryForCandidate(message: string, matched: string): MemoryCategory {
  if (/i am\b|my name\b|i work as\b|i'?m a\b/i.test(matched)) return 'identity'
  if (/\bnever\b|\bdon'?t\b|\bdo not\b|make sure\b/i.test(matched)) return 'behavioral'
  if (/\bprefer\b|i like\b|i don'?t (?:like|want)\b/i.test(matched)) return 'preference'
  if (
    /\bproject|repository|codebase|stack|tooling\b|download|install|track|progress\b/i.test(message)
  )
    return 'project-rule'
  if (/golden rule|standing rule|must be|should be/i.test(matched)) return 'project-rule'
  return 'preference'
}

function priorityForCandidate(matched: string): MemoryPriority {
  return /\b(?:always|never|from now on|in future|going forward|golden rule|standing rule|every time|not a one[ -]?time)\b/iu.test(
    matched
  )
    ? 'high'
    : 'medium'
}

/** Extract the sentences of the user message that carry a standing marker. */
function extractDurableContent(message: string): string {
  const sentences = message.split(/(?<=[.!?])\s+/u)
  const durable = sentences.filter(
    (sentence) =>
      STANDING_PREFERENCE_PATTERN.test(sentence) ||
      DURABLE_RULE_PATTERN.test(sentence) ||
      hasUniversalDeonticSignal(sentence)
  )
  if (durable.length > 0) return durable.join(' ')
  if (hasDurableSignal(message)) return message
  // Frustration-driven turns: keep the frustrated sentences that carry rule-like content
  if (hasFrustrationSignal(message)) {
    const frustrated = sentences.filter((sentence) => hasRuleLikeContent(sentence))
    if (frustrated.length > 0) return frustrated.join(' ')
    return message
  }
  return ''
}

/**
 * Deterministic, model-free memory candidate detection. Returns at most
 * `maxCandidates` candidates; a turn that is a question, acknowledgement,
 * continuation, one-off task instruction, or contains no standing-preference
 * vocabulary yields no candidate (and therefore no auxiliary model call).
 */
export function detectMemoryCandidates(input: {
  userMessage: string
  assistantResponse: string
  existingEntries: MemoryEntry[]
  projectId?: string
  threadId?: string
}): MemoryCandidate[] {
  const user = input.userMessage.trim()
  if (isTrivialUserTurn(user)) return []
  const durable = hasDurableSignal(user)
  const frustrated = hasFrustrationSignal(user)
  if (!durable && !frustrated) return []
  if (frustrated && !durable && !hasRuleLikeContent(user)) return []

  const content = extractDurableContent(user)
  if (!content) return []
  const cappedContent = capText(content, MEMORY_EXTRACTION_LIMITS.maxUserCandidateCharacters)
  const standingMatch = STANDING_PREFERENCE_PATTERN.exec(cappedContent)
  const durableMatch = DURABLE_RULE_PATTERN.exec(cappedContent)
  const matched = standingMatch
    ? standingMatch[0]
    : durableMatch
      ? durableMatch[0]
      : cappedContent.slice(0, 80)
  const existing = new Set(
    input.existingEntries
      .filter((entry) => entry.enabled)
      .map((entry) => normalizeText(entry.content))
  )
  const scope: MemoryScope = input.projectId === 'inbox' ? 'thread' : 'project'
  const candidate: MemoryCandidate = {
    label: capText(cappedContent, MEMORY_LIMITS.maxLabelCharacters),
    content: cappedContent,
    category: categoryForCandidate(cappedContent, matched),
    priority: priorityForCandidate(cappedContent),
    scope
  }
  const normalized = normalizeText(candidate.content)
  if (existing.has(normalized)) return []

  const candidates: MemoryCandidate[] = [candidate]
  // Deduplicate within this turn (identical normalized content).
  return candidates.filter(
    (item, index) =>
      candidates.findIndex(
        (other) => normalizeText(other.content) === normalizeText(item.content)
      ) === index
  )
}

export interface MemoryExtractionLimits {
  maxUserCandidateCharacters: number
  maxAssistantCandidateCharacters: number
  maxCandidates: number
  debounceMs: number
  maxExtractionsPerWindow: number
  extractionWindowMs: number
  cheapModelTokenBudget: number
}

/** Read the cheap-model extraction budget, overridable per deployment. */
export function readMemoryExtractionLimits(): MemoryExtractionLimits {
  const tokenBudget = readPositiveIntEnv('CODEINOVEN_MEMORY_TOKEN_BUDGET')
  const debounceMs = readPositiveIntEnv('CODEINOVEN_MEMORY_DEBOUNCE_MS')
  const maxPerWindow = readPositiveIntEnv('CODEINOVEN_MEMORY_MAX_PER_WINDOW')
  return {
    ...MEMORY_EXTRACTION_LIMITS,
    cheapModelTokenBudget: tokenBudget ?? MEMORY_EXTRACTION_LIMITS.cheapModelTokenBudget,
    debounceMs: debounceMs ?? MEMORY_EXTRACTION_LIMITS.debounceMs,
    maxExtractionsPerWindow: maxPerWindow ?? MEMORY_EXTRACTION_LIMITS.maxExtractionsPerWindow
  }
}

function readPositiveIntEnv(name: string): number | null {
  const value = process.env[name]
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}
