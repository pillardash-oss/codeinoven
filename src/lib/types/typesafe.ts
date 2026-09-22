/**
 * Shared types for the app-owned TypeSafe (Jev) decision capability.
 *
 * No Node imports live here, so the renderer reads `TypesafeStatus` and
 * `TypesafeCheckResult` the same way it reads `CuaBridgeStatus`: state only,
 * never the key.
 */

/**
 * Instructions for one question: a plain string, or structured data whose
 * fields the instructions refer to by name. Mirrors the wire contract.
 */
export type TypesafeInstructions = string | Record<string, unknown> | unknown[]

/** The content the model evaluates. A plain string for text, or structured data. */
export type TypesafeState = string | Record<string, unknown> | unknown[]

/** One of the three documented question primitives. */
export type TypesafeQuestionType = 'noul' | 'choice' | 'score'

/** Yes/no question. Answered as the probability that the answer is yes. */
export interface TypesafeNoulQuestion {
  type: 'noul'
  instructions: TypesafeInstructions
  /** What a yes and a no mean, when the bare question is ambiguous. */
  criteria?: { true?: TypesafeInstructions; false?: TypesafeInstructions }
}

/** Picks one option from a set the caller defines. */
export interface TypesafeChoiceQuestion {
  type: 'choice'
  instructions: TypesafeInstructions
  /** Option to rubric description. `null` when an option needs no extra detail. */
  criteria: Record<string, TypesafeInstructions | null>
}

/** Rates the state across an ordered rubric. */
export interface TypesafeScoreQuestion {
  type: 'score'
  instructions: TypesafeInstructions
  /** Ordered level descriptions; at least two, at most ten. */
  criteria: TypesafeInstructions[]
}

export type TypesafeQuestion = TypesafeNoulQuestion | TypesafeChoiceQuestion | TypesafeScoreQuestion

/** Questions keyed by an id the caller chooses; answers return under the same ids. */
export type TypesafeQuestionMap = Record<string, TypesafeQuestion>

export interface TypesafeNoulAnswer {
  type: 'noul'
  /** 0 is no, 1 is yes. */
  noul: number
}

export interface TypesafeChoiceAnswer {
  type: 'choice'
  /** Highest-probability option, always one the caller declared. */
  choice: string
  /** Every declared option mapped to its probability. */
  probabilities: Record<string, number>
  confidence: number
}

export interface TypesafeScoreAnswer {
  type: 'score'
  /** Probability-weighted value across the levels; can land between levels. */
  score: number
  /** Level index mapped back to its description. */
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

export type TypesafeAnswer = TypesafeNoulAnswer | TypesafeChoiceAnswer | TypesafeScoreAnswer

export type TypesafeAnswerMap = Record<string, TypesafeAnswer>

/** Token usage the service reported for one call. */
export interface TypesafeUsage {
  inputTokens: number
  outputTokens: number
}

/**
 * Why a call did not produce an answer, or that a produced answer was too weak
 * to act on. `below-threshold` is decided locally from the answer's own
 * numbers, never by the service.
 */
export type TypesafeDecisionStatus =
  | 'answered'
  | 'below-threshold'
  | 'not-configured'
  | 'disabled'
  | 'rejected'
  | 'rate-limited'
  | 'unavailable'
  | 'invalid-response'
  | 'over-budget'
  | 'cooling-down'

/** The subset a transport or service condition can produce. */
export type TypesafeCallStatus = Exclude<TypesafeDecisionStatus, 'below-threshold' | 'answered'>

/** Where the key in use came from, so the UI can say so instead of guessing. */
export type TypesafeKeySource =
  /** Stored by this device's Settings card. */
  | 'device'
  /** `TYPESAFE_API_KEY` in the environment CodeInOven launched with. */
  | 'environment'
  /** A credential a user attached to an installed utility. */
  | 'utility'
  /** A secret set inside one thread through `cio_ask_secret`. */
  | 'thread'

/** Confidence floors applied in code before a seam may act on an answer. */
export interface TypesafeThresholds {
  /** Minimum `noul` probability that counts as yes. */
  noul: number
  /** Minimum confidence for a `choice` or `score` answer. */
  confidence: number
}

/** One call a seam makes. */
export interface TypesafeDecisionRequest {
  /** Which seam asked, for the audit line and for future per-seam thresholds. */
  seam: string
  state: TypesafeState
  questions: TypesafeQuestionMap
  /** Hard cap for this call. Defaults to the capability budget. */
  timeoutMs?: number
  /** Overrides the capability defaults for this seam only. */
  thresholds?: Partial<TypesafeThresholds>
  /** Thread the decision belongs to, when the seam runs inside one. */
  threadId?: string
}

/**
 * What a seam receives. `answered` means the answer also cleared the
 * thresholds; anything else means the seam runs the code it runs today.
 */
export type TypesafeDecision =
  | {
      status: 'answered'
      answers: TypesafeAnswerMap
      /** Versioned id that answered, e.g. `jev-1.13.0`. */
      model: string
      requestId?: string
      latencyMs: number
      usage?: TypesafeUsage
    }
  | { status: Exclude<TypesafeDecisionStatus, 'answered'>; detail?: string }

/** Coarse state of the capability, for the Settings card. */
export type TypesafeAvailability =
  'unconfigured' | 'unverified' | 'ready' | 'rejected' | 'rate-limited' | 'unavailable'

/** The last failure, kept only so the card can report what actually happened. */
export interface TypesafeFailure {
  status: TypesafeCallStatus
  detail: string
  /** Service-side request id, present on every non-2xx response. */
  requestId?: string
  at: number
}

/** Renderer-safe state of the capability. The key value is never included. */
export interface TypesafeStatus {
  hasKey: boolean
  keySource: TypesafeKeySource | null
  /** Human detail for the source: the utility name or the thread id. */
  keySourceDetail?: string
  availability: TypesafeAvailability
  /** True once a call has succeeded in this app session. */
  verified: boolean
  /** Versioned model id that last answered. */
  model?: string
  /** Whether the OS keychain is available, which decides if a key can be stored. */
  secureStorageAvailable: boolean
  lastFailure?: TypesafeFailure
  /** Epoch ms of the last successful verification, for the card's label. */
  verifiedAt?: number
}

/** Result of the one real typed question the "Check connection" action sends. */
export type TypesafeCheckResult =
  | { ok: true; model: string; latencyMs: number; usage?: TypesafeUsage }
  | { ok: false; status: TypesafeCallStatus; detail: string; requestId?: string }
