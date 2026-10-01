import {
  MEDIA_GENERATION_POLL_MS,
  MEDIA_GENERATION_REQUEST_TIMEOUT_MS,
  MEDIA_PROVIDERS
} from '../../lib/media-generation'
import { Logger } from '../system/logger'
import type { MediaProvider, MediaProviderCall, MediaProviderResult } from './media-provider'

/**
 * The Replicate backend.
 *
 * Verified against Replicate's own HTTP reference rather than recalled: a bearer
 * token authorizes every call, a hosted model is created at
 * `POST /v1/models/{owner}/{name}/predictions` with a bare `input` object, a
 * pinned version at `POST /v1/predictions` with `{ version, input }`, and the run
 * is read back from the `urls.get` the create answered with until its `status`
 * reaches a terminal value.
 *
 * Async plus polling is used even for a still, instead of the documented
 * `Prefer: wait` sync mode, because sync holds one request for the whole run and
 * caps at a minute by default, which no video model fits. Polling also gives the
 * turn a deadline it can enforce.
 */

/** How long one HTTP call may take, so a stalled socket cannot eat the budget. */
const REQUEST_TIMEOUT_MS = MEDIA_GENERATION_REQUEST_TIMEOUT_MS

/** Statuses that mean the run is over, whichever way it ended. */
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])

/** Longest provider error body echoed into a message. */
const ERROR_BODY_LIMIT = 400

interface ReplicateUrls {
  get: string | null
}

interface ReplicatePrediction {
  id: string | null
  status: string
  output: unknown
  error: string | null
  urls: ReplicateUrls
}

export interface ReplicateProviderOptions {
  /** The user's API token. Never logged, never persisted outside the vault. */
  token: string
  /** Overridable so a probe can point the same client at a local server. */
  endpoint?: string
  /** Injected for a probe; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Read a prediction body, ignoring every field the app does not act on. */
function readPrediction(value: unknown): ReplicatePrediction | null {
  if (!isRecord(value)) return null
  const status = readString(value['status'])
  if (!status) return null
  const urls = isRecord(value['urls']) ? value['urls'] : {}
  return {
    id: readString(value['id']),
    status,
    output: value['output'],
    error: readString(value['error']),
    urls: { get: readString(urls['get']) }
  }
}

/**
 * The first URL inside a prediction's output.
 *
 * A model may answer with a bare URL, a list of them, or an object carrying one,
 * and which it is depends on the model rather than on the request. The first
 * usable URL wins, because a design references one asset per call.
 */
function outputUrl(output: unknown): string | null {
  if (typeof output === 'string') return output.length > 0 ? output : null
  if (Array.isArray(output)) {
    for (const entry of output) {
      const found = outputUrl(entry)
      if (found) return found
    }
    return null
  }
  if (isRecord(output)) return readString(output['url'])
  return null
}

/** A bounded, single-line version of a provider error body. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/gu, ' ').trim()
    return text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}...` : text
  } catch {
    return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A provider error that names the run, so a failure can be traced. */
function failure(message: string, jobId: string | null): Error {
  return new Error(jobId ? `${message} (run ${jobId})` : message)
}

class ReplicateProvider implements MediaProvider {
  readonly id = 'replicate' as const
  private readonly token: string
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch

  constructor(options: ReplicateProviderOptions) {
    this.token = options.token
    this.endpoint = (options.endpoint ?? MEDIA_PROVIDERS.replicate.endpoint).replace(/\/+$/u, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json'
    }
  }

  /** Create the run and return what it answered, without waiting. */
  private async create(call: MediaProviderCall): Promise<{
    jobId: string | null
    pollUrl: string
    prediction: ReplicatePrediction
  }> {
    const url =
      call.ref.kind === 'model'
        ? `${this.endpoint}/models/${call.ref.owner}/${call.ref.name}/predictions`
        : `${this.endpoint}/predictions`
    const body =
      call.ref.kind === 'model'
        ? { input: call.input }
        : { version: call.ref.version, input: call.input }

    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      const detail = await readErrorDetail(response)
      throw new Error(
        `Replicate refused the run with HTTP ${response.status}${detail ? `: ${detail}` : ''}`
      )
    }
    const prediction = readPrediction(await response.json())
    if (!prediction) throw new Error('Replicate answered with a body this app could not read')
    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      throw failure(
        `Replicate could not run the model: ${prediction.error ?? prediction.status}`,
        prediction.id
      )
    }
    const pollUrl = prediction.urls.get ?? `${this.endpoint}/predictions/${prediction.id ?? ''}`
    return { jobId: prediction.id, pollUrl, prediction }
  }

  /** Read one run back, until it reaches a terminal status or the deadline wins. */
  private async poll(
    start: { jobId: string | null; pollUrl: string },
    timeoutMs: number
  ): Promise<ReplicatePrediction> {
    const deadline = Date.now() + timeoutMs
    let jobId = start.jobId
    while (Date.now() < deadline) {
      const response = await this.fetchImpl(start.pollUrl, {
        headers: this.headers(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!response.ok) {
        const detail = await readErrorDetail(response)
        throw failure(
          `Replicate could not report the run: HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
          jobId
        )
      }
      const prediction = readPrediction(await response.json())
      if (!prediction) throw new Error('Replicate answered with a body this app could not read')
      jobId = prediction.id ?? jobId
      if (TERMINAL_STATUSES.has(prediction.status)) return prediction
      await sleep(MEDIA_GENERATION_POLL_MS)
    }
    throw failure(
      `Replicate did not finish within ${Math.round(timeoutMs / 60_000)} minutes`,
      jobId
    )
  }

  async generate(call: MediaProviderCall): Promise<MediaProviderResult> {
    const started = await this.create(call)
    // A fast model may already be finished when the create answers, so the first
    // status is used rather than polled again.
    const finished = TERMINAL_STATUSES.has(started.prediction.status)
      ? started.prediction
      : await this.poll(started, call.timeoutMs)
    const jobId = finished.id ?? started.jobId ?? ''
    if (finished.status !== 'succeeded') {
      throw failure(
        `Replicate could not run the model: ${finished.error ?? finished.status}`,
        jobId || null
      )
    }
    const url = outputUrl(finished.output)
    if (!url) {
      throw failure(
        'Replicate finished the run but answered with no file this app could fetch',
        jobId || null
      )
    }
    Logger.dev(`Replicate run ${jobId} finished`)
    return { url, jobId }
  }
}

/** Build the Replicate provider for one token. */
export function createReplicateProvider(options: ReplicateProviderOptions): MediaProvider {
  return new ReplicateProvider(options)
}
