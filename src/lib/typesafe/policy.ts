import type {
  TypesafeAnswerMap,
  TypesafeQuestion,
  TypesafeQuestionMap,
  TypesafeState,
  TypesafeThresholds
} from '../types/typesafe'

/** Documented ceiling on the options one Choice question may declare. */
const CHOICE_OPTION_LIMIT = 255

/** Documented Score range: at least two levels, at most ten. */
const SCORE_LEVEL_MINIMUM = 2
const SCORE_LEVEL_MAXIMUM = 10

/**
 * Context the service accepts for the state plus the single longest question.
 * The documented wire limit is 32k tokens; this stays under it, so an oversize
 * payload is caught here instead of becoming a paid round trip that fails.
 */
export const TYPESAFE_STATE_TOKEN_BUDGET = 30_000

/**
 * What TypeSafe charges, per million input tokens.
 *
 * Output tokens are free on every model the service lists, so a call is priced
 * entirely by what was sent.
 */
const TYPESAFE_USD_PER_INPUT_MTOK = 0.042

/** Characters per token, the conservative estimate used for local budgeting. */
const CHARACTERS_PER_TOKEN = 4

/**
 * Confidence floors every seam starts from.
 *
 * They are applied in code, never by the service, so a confident-sounding
 * answer cannot talk the app into acting on a coin flip. A seam that measures
 * better numbers for its own decisions overrides these through
 * `TypesafeDecisionRequest.thresholds`.
 */
export const DEFAULT_TYPESAFE_THRESHOLDS: TypesafeThresholds = { noul: 0.7, confidence: 0.6 }

/**
 * Estimated cost of one call, from the usage the service reported.
 *
 * An estimate rather than a bill: the service reports tokens, not money, and
 * published pricing can change. It exists so a decision's own record carries what
 * it cost, which makes the ledger checkable against real usage instead of against
 * a number someone remembered.
 */
export function typesafeCostUsd(usage: { inputTokens: number; outputTokens: number }): number {
  return (usage.inputTokens / 1_000_000) * TYPESAFE_USD_PER_INPUT_MTOK
}

/** Rough token count of one request payload, used before anything is sent. */
export function estimateTypesafeTokens(
  state: TypesafeState,
  questions: TypesafeQuestionMap
): number {
  const characters = JSON.stringify({ state, questions })?.length ?? 0
  return Math.ceil(characters / CHARACTERS_PER_TOKEN)
}

/**
 * Reject a question map the service would refuse anyway, so a caller bug is a
 * local error with the offending key named rather than a 422.
 */
export function validateTypesafeQuestions(questions: TypesafeQuestionMap): void {
  if (typeof questions !== 'object' || questions === null || Array.isArray(questions)) {
    throw new TypeError('TypeSafe questions must be a map keyed by question id')
  }
  const ids = Object.keys(questions)
  if (ids.length === 0) throw new TypeError('TypeSafe questions must not be empty')
  for (const id of ids) {
    if (!id.trim()) throw new TypeError('A TypeSafe question id must not be empty')
    const question = questions[id] as TypesafeQuestion
    if (typeof question !== 'object' || question === null) {
      throw new TypeError(`TypeSafe question "${id}" must be an object`)
    }
    if (!question.instructions) {
      throw new TypeError(`TypeSafe question "${id}" must carry instructions`)
    }
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria ?? {})
      if (options.length === 0) {
        throw new TypeError(`TypeSafe choice "${id}" must declare at least one option`)
      }
      if (options.length > CHOICE_OPTION_LIMIT) {
        throw new TypeError(
          `TypeSafe choice "${id}" declares ${options.length} options; the service accepts ${CHOICE_OPTION_LIMIT}`
        )
      }
      continue
    }
    if (question.type === 'score') {
      const levels = question.criteria?.length ?? 0
      if (levels < SCORE_LEVEL_MINIMUM || levels > SCORE_LEVEL_MAXIMUM) {
        throw new TypeError(
          `TypeSafe score "${id}" must declare between ${SCORE_LEVEL_MINIMUM} and ${SCORE_LEVEL_MAXIMUM} levels`
        )
      }
      continue
    }
    if (question.type !== 'noul') {
      throw new TypeError(`TypeSafe question "${id}" has an unknown type`)
    }
  }
}

/** What one answered question looks like once the floors are applied. */
export interface TypesafeAnswerReview {
  /** True only when every question cleared its floor. */
  accepted: boolean
  /** Ids that fell short, so a caller can log or narrow its next request. */
  failed: string[]
}

/**
 * Turn probabilities into a decision.
 *
 * A yes/no answer is compared against its floor, and a choice or score answer
 * against its confidence. Anything at or above the floor is a judgment the app
 * may act on; anything below is treated as no answer at all, which is what
 * keeps a weak model from steering a seam.
 */
export function reviewTypesafeAnswers(
  answers: TypesafeAnswerMap,
  thresholds: TypesafeThresholds
): TypesafeAnswerReview {
  const failed: string[] = []
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === 'noul') {
      if (answer.noul < thresholds.noul) failed.push(id)
      continue
    }
    if (answer.confidence < thresholds.confidence) failed.push(id)
  }
  return { accepted: failed.length === 0, failed }
}

/** Merge a request's overrides over the capability defaults. */
export function resolveTypesafeThresholds(
  overrides?: Partial<TypesafeThresholds>
): TypesafeThresholds {
  if (!overrides) return DEFAULT_TYPESAFE_THRESHOLDS
  return {
    noul: overrides.noul ?? DEFAULT_TYPESAFE_THRESHOLDS.noul,
    confidence: overrides.confidence ?? DEFAULT_TYPESAFE_THRESHOLDS.confidence
  }
}
