import type { MediaModelRef, MediaProviderId } from '../../lib/media-generation'

/**
 * One generation backend, behind the contract the app calls.
 *
 * A provider turns a model reference and an input object into a URL that holds
 * the bytes. It does not write files: fetching the result and writing it safely
 * is the app's job, shared with `save-media` so there is exactly one writer of
 * media on disk (`src/main/design/design-media-service.ts`).
 */

/** One generation, as the provider receives it. */
export interface MediaProviderCall {
  /** The model to run, in the provider's own spelling. */
  ref: MediaModelRef
  /** The input object, already carrying the prompt under the right field. */
  input: Record<string, unknown>
  /** How long the whole run may take before it is abandoned. */
  timeoutMs: number
}

/** What a finished generation produced. */
export interface MediaProviderResult {
  /** The https URL holding the bytes. */
  url: string
  /** The provider's own identifier for the run, for a log line or an error. */
  jobId: string
}

/** A backend the app can call, constructed with the user's token. */
export interface MediaProvider {
  readonly id: MediaProviderId
  generate(call: MediaProviderCall): Promise<MediaProviderResult>
}
