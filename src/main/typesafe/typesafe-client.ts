import type {
  TypesafeAnswer,
  TypesafeAnswerMap,
  TypesafeChoiceQuestion,
  TypesafeQuestionMap,
  TypesafeScoreQuestion,
  TypesafeState,
  TypesafeUsage,
  TypesafeCallStatus
} from '../../lib/types'
import { classifyTypesafeHttpStatus, parseRetryAfterMs } from '../../lib/typesafe/availability'

/** The one endpoint every TypeSafe model is served from. */
const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

/**
 * Model alias this app requests.
 *
 * Every answer carries the versioned model that produced it, so pinning a
 * version later is a one-line change; until a seam has thresholds measured
 * against a version, the alias keeps the capability working across releases.
 */
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest'

/** Hard cap for one call, far below the CLI budgets it will replace. */
export const TYPESAFE_DEFAULT_TIMEOUT_MS = 8_000

/** One retry, for a transport fault or a 5xx, after this delay. */
const RETRY_DELAY_MS = 400

/** Longest error detail kept from the service, so a body cannot flood a log line. */
const DETAIL_LIMIT = 400

export interface TypesafeCallRequest {
  apiKey: string
  state: TypesafeState
  questions: TypesafeQuestionMap
  model?: string
  timeoutMs?: number
}

/** What one call to the service produced. Never throws. */
export type TypesafeCallOutcome =
  | {
      status: 'answered'
      answers: TypesafeAnswerMap
      /** Versioned id that answered, e.g. `jev-1.13.0`. */
      model: string
      requestId?: string
      usage?: TypesafeUsage
      latencyMs: number
    }
  | {
      status: TypesafeCallStatus
      detail: string
      requestId?: string
      latencyMs: number
      /** Milliseconds the service asked us to wait, when it said so. */
      retryAfterMs?: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readProbabilityMap(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  const map: Record<string, number> = {}
  for (const [key, entry] of entries) {
    const probability = readNumber(entry)
    if (probability === undefined) return undefined
    map[key] = probability
  }
  return map
}

/** Highest probability in a distribution, used when confidence is not reported. */
function topProbability(probabilities: Record<string, number>): number | undefined {
  const values = Object.values(probabilities)
  return values.length > 0 ? Math.max(...values) : undefined
}

/**
 * Read one answer against the question that asked it.
 *
 * The shape is checked rather than trusted, and a Choice whose chosen option was
 * never offered is refused outright: an answer the app acts on must always be
 * one of the options the app itself declared.
 */
function readAnswer(question: TypesafeQuestionMap[string], value: unknown): TypesafeAnswer | null {
  if (!isRecord(value)) return null
  if (value['type'] !== question.type) return null

  if (question.type === 'noul') {
    const noul = readNumber(value['noul'])
    if (noul === undefined || noul < 0 || noul > 1) return null
    return { type: 'noul', noul }
  }

  const probabilities = readProbabilityMap(value['probabilities'])
  const reportedConfidence = readNumber(value['confidence'])
  const confidence =
    reportedConfidence ?? (probabilities ? topProbability(probabilities) : undefined)
  if (confidence === undefined || confidence < 0 || confidence > 1) return null

  if (question.type === 'choice') {
    const choice = value['choice']
    if (typeof choice !== 'string') return null
    const criteria = (question as TypesafeChoiceQuestion).criteria ?? {}
    if (!(choice in criteria)) return null
    return {
      type: 'choice',
      choice,
      probabilities: probabilities ?? {},
      confidence
    }
  }

  const score = readNumber(value['score'])
  if (score === undefined) return null
  const legendValue = isRecord(value['legend']) ? value['legend'] : {}
  const legend: Record<string, string> = {}
  for (const [key, entry] of Object.entries(legendValue)) {
    if (typeof entry === 'string') legend[key] = entry
  }
  const levels = (question as TypesafeScoreQuestion).criteria?.length ?? 0
  if (score < 0 || score > Math.max(levels - 1, 0)) return null
  return {
    type: 'score',
    score,
    legend,
    probabilities: probabilities ?? {},
    confidence
  }
}

/**
 * Read the whole answer map against the questions that were asked.
 *
 * One unusable answer fails the call: a partially understood response is more
 * dangerous than none, because a seam would act on the half that parsed.
 */
function readAnswers(payload: unknown, questions: TypesafeQuestionMap): TypesafeAnswerMap | null {
  if (!isRecord(payload)) return null
  const answers = payload['answers']
  if (!isRecord(answers)) return null
  const result: TypesafeAnswerMap = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = readAnswer(question, answers[id])
    if (!answer) return null
    result[id] = answer
  }
  return result
}

function readUsage(value: unknown): TypesafeUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = readNumber(value['input_tokens'])
  const outputTokens = readNumber(value['output_tokens'])
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return { inputTokens, outputTokens }
}

/** The service's message in whichever of its documented shapes it arrived. */
function readErrorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    if (isRecord(parsed)) {
      const detail = parsed['detail']
      if (typeof detail === 'string') return detail.slice(0, DETAIL_LIMIT)
      if (isRecord(detail)) {
        const message = detail['message']
        if (typeof message === 'string') return message.slice(0, DETAIL_LIMIT)
        const errorType = detail['error_type']
        if (typeof errorType === 'string') return errorType.slice(0, DETAIL_LIMIT)
      }
      const message = parsed['message']
      if (typeof message === 'string') return message.slice(0, DETAIL_LIMIT)
    }
  } catch {
    // Not JSON; the raw body below is the best description available.
  }
  const text = body.trim()
  return text ? text.slice(0, DETAIL_LIMIT) : 'TypeSafe returned an empty error body'
}

/** One attempt, so the caller owns retrying and the cap. */
async function attemptCall(
  request: TypesafeCallRequest,
  model: string,
  timeoutMs: number
): Promise<TypesafeCallOutcome> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ state: request.state, model, questions: request.questions }),
      signal: controller.signal
    })
    const latencyMs = Date.now() - startedAt
    const requestId = response.headers.get('x-typesafe-request-id') ?? undefined
    const body = await response.text()

    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      return {
        status: classifyTypesafeHttpStatus(response.status),
        detail: readErrorDetail(body),
        ...(requestId ? { requestId } : {}),
        latencyMs,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {})
      }
    }

    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      return {
        status: 'invalid-response',
        detail: 'TypeSafe returned a body that is not JSON',
        ...(requestId ? { requestId } : {}),
        latencyMs
      }
    }

    const answers = readAnswers(payload, request.questions)
    if (!answers) {
      return {
        status: 'invalid-response',
        detail: 'TypeSafe returned an answer that does not match the questions asked',
        ...(requestId ? { requestId } : {}),
        latencyMs
      }
    }

    const modelId = isRecord(payload) ? payload['model'] : undefined
    const usage = isRecord(payload) ? readUsage(payload['usage']) : undefined
    return {
      status: 'answered',
      answers,
      model: typeof modelId === 'string' && modelId ? modelId : model,
      ...(requestId ? { requestId } : {}),
      ...(usage ? { usage } : {}),
      latencyMs
    }
  } catch (error) {
    const latencyMs = Date.now() - startedAt
    const timedOut = controller.signal.aborted
    return {
      status: 'unavailable',
      detail: timedOut
        ? `TypeSafe did not answer within ${timeoutMs} ms`
        : `TypeSafe could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      latencyMs
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Ask the service one question set.
 *
 * Retrying is deliberately narrow: a transport fault and a 5xx get one more
 * attempt inside the same cap, because both are usually a blip. A refusal, a
 * rate limit and a malformed payload are answers in themselves, so they are
 * returned to the caller unchanged instead of being retried.
 */
export async function callTypesafe(request: TypesafeCallRequest): Promise<TypesafeCallOutcome> {
  const model = request.model ?? TYPESAFE_DEFAULT_MODEL
  const timeoutMs = request.timeoutMs ?? TYPESAFE_DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()

  const first = await attemptCall(request, model, timeoutMs)
  if (first.status !== 'unavailable') return first
  // A timeout is not retried: the cap has already been spent once.
  if (first.detail.includes('did not answer within')) return first

  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
  const remaining = timeoutMs - (Date.now() - startedAt)
  if (remaining <= 0) return first
  const second = await attemptCall(request, model, remaining)
  return second.status === 'unavailable' ? { ...second, latencyMs: Date.now() - startedAt } : second
}
