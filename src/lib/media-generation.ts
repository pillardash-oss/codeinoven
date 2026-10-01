import type { DesignMediaKind } from './design-media'

/**
 * Generated media as an app capability: which provider can be called, what a
 * model reference looks like, and what one generation is allowed to cost.
 *
 * The app had no way to make a picture, a clip or a track. An agent that needed
 * a music bed had to improvise one, because the only lane a design could staff
 * was a text completion (`src/main/design/design-assignment-executor.ts`). This
 * module is the decision half of fixing that: the provider the app can speak to,
 * the model spelling that provider uses, and the ceilings one call is held to.
 * The call itself lives in `src/main/media/`.
 *
 * Pure, with no `node:*` import, so the tool schema, the settings UI, the
 * executor and a probe all read the same table.
 */

/** The generation backends the app knows how to call. */
export type MediaProviderId = 'replicate'

/** Every provider, in the order settings offers them. */
export const MEDIA_PROVIDER_IDS: readonly MediaProviderId[] = ['replicate']

/** One backend, as settings and an error message describe it. */
export interface MediaProviderInfo {
  id: MediaProviderId
  /** Product name, as the user knows it. */
  label: string
  /** Where a token comes from, shown beside the field that takes it. */
  keyUrl: string
  /** One line on what the token unlocks. */
  description: string
  /** Where the app's requests are sent. A field, not a constant, so a probe can
   *  point the same client at a local server. */
  endpoint: string
}

export const MEDIA_PROVIDERS: Readonly<Record<MediaProviderId, MediaProviderInfo>> = {
  replicate: {
    id: 'replicate',
    label: 'Replicate',
    keyUrl: 'https://replicate.com/account/api-tokens',
    description:
      'One token reaches hosted image, video and audio models, so the model you assign to a craft is your choice rather than this app building a separate integration for each one.',
    endpoint: 'https://api.replicate.com/v1'
  }
}

/** Whether a value names a provider the app can call. */
export function isMediaProviderId(value: unknown): value is MediaProviderId {
  return typeof value === 'string' && (MEDIA_PROVIDER_IDS as readonly string[]).includes(value)
}

/** The provider's product name, falling back to the raw id for a config a future
 *  version wrote and this one does not know. */
export function mediaProviderLabel(id: string): string {
  return isMediaProviderId(id) ? MEDIA_PROVIDERS[id].label : id
}

/** Longest accepted model reference: a spelling, never a payload. */
export const MEDIA_MODEL_MAX_LENGTH = 200

/**
 * A model as the provider spells it.
 *
 * A hosted model is named `owner/name`; a pinned version is its hash. The two
 * are different endpoints, so they are different shapes here rather than a
 * string the caller has to sniff.
 */
export type MediaModelRef =
  { kind: 'model'; owner: string; name: string } | { kind: 'version'; version: string }

const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu
const VERSION_PATTERN = /^[a-f0-9]{40,64}$/iu

/**
 * Read a model reference, accepting the spellings a user actually pastes.
 *
 * `black-forest-labs/flux-1.1-pro`, the same id inside a `replicate.com` page
 * URL, and a 40 or 64 character version hash are all accepted; anything else is
 * refused here rather than sent and rejected by the provider with a vaguer
 * message.
 */
export function parseMediaModelRef(raw: string): MediaModelRef | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MEDIA_MODEL_MAX_LENGTH) return null

  // A pasted page URL carries the id in its last two path segments.
  let candidate = trimmed
  if (/^https?:\/\//iu.test(candidate)) {
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      return null
    }
    if (!/(^|\.)replicate\.com$/iu.test(url.hostname)) return null
    const parts = url.pathname.split('/').filter(Boolean)
    candidate = parts.slice(-2).join('/')
  }

  if (VERSION_PATTERN.test(candidate)) return { kind: 'version', version: candidate.toLowerCase() }

  const slash = candidate.indexOf('/')
  if (slash <= 0 || slash === candidate.length - 1) return null
  const owner = candidate.slice(0, slash)
  const name = candidate.slice(slash + 1)
  if (owner.includes('/') || !MODEL_NAME_PATTERN.test(owner) || !MODEL_NAME_PATTERN.test(name)) {
    return null
  }
  return { kind: 'model', owner, name }
}

/** The reference as a single string, for a label or an error message. */
export function mediaModelRefLabel(ref: MediaModelRef): string {
  return ref.kind === 'model' ? `${ref.owner}/${ref.name}` : ref.version
}

/** Longest accepted prompt for one generation. */
export const MEDIA_PROMPT_MAX_LENGTH = 4_000

/** Most provider input overrides one call may carry. */
export const MEDIA_INPUT_OPTION_MAX = 24

/** Longest serialized provider input, so a hand-written call cannot inflate a request. */
export const MEDIA_INPUT_JSON_MAX = 4_000

/** One generation request: what the agent asks for, before the app fills the rest. */
export interface MediaGenerationRequest {
  /** Which craft's model answers this call. */
  kind: DesignMediaKind
  /** The complete brief for the model. */
  prompt: string
  /**
   * The input field the prompt is sent under. Defaults to `prompt`, and is set
   * only when the model documents another name (for example `text`). Sending the
   * prompt under two spellings would make a model that validates its input
   * schema reject the call, so the field is named here rather than sniffed from
   * the options.
   */
  promptField?: string
  /** File name without an extension. Derived from the model when absent. */
  name?: string
  /** Project-relative folder to write into. The caller validates it. */
  directory?: string
  /**
   * Provider-specific input fields, such as an aspect ratio or a duration. Passed
   * through as written, because every hosted model spells its own parameters
   * differently and the app cannot pretend to know them all.
   */
  options?: Record<string, unknown>
}

/**
 * How long one generation may run before the app gives up.
 *
 * A still is seconds of work and must not hold a turn for minutes; a clip is
 * minutes of work and is the one asset a turn is allowed to wait for. These are
 * the app's patience, not the provider's queue depth, so a busy provider is
 * reported as a timeout rather than waited on forever.
 */
export const MEDIA_GENERATION_TIMEOUT_MS: Readonly<Record<DesignMediaKind, number>> = {
  image: 5 * 60_000,
  audio: 10 * 60_000,
  video: 20 * 60_000
}

/** Gap between status reads while a generation runs. */
export const MEDIA_GENERATION_POLL_MS = 2_000

/** Deadline for one status read, so a stalled connection cannot eat the budget. */
export const MEDIA_GENERATION_REQUEST_TIMEOUT_MS = 30_000

/** Whether a model reference may be stored for a craft. */
export function isValidMediaModel(raw: unknown): raw is string {
  return typeof raw === 'string' && parseMediaModelRef(raw) !== null
}

/**
 * The default input field a prompt is sent under.
 *
 * Hosted models disagree, but `prompt` is the common spelling, so it is the
 * default and an explicit `options.prompt` overrides it rather than being
 * silently ignored.
 */
export const MEDIA_PROMPT_INPUT_FIELD = 'prompt'

/** Longest accepted prompt-field name. */
export const MEDIA_PROMPT_FIELD_MAX_LENGTH = 48

const PROMPT_FIELD_PATTERN = /^[a-z][a-z0-9_]*$/u

/** Whether a value names an input field the prompt may be sent under. */
export function isValidPromptField(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MEDIA_PROMPT_FIELD_MAX_LENGTH &&
    PROMPT_FIELD_PATTERN.test(value)
  )
}

/**
 * Build the provider input object for one request.
 *
 * The prompt lands under one field and only one, named by `promptField` when the
 * model spells it differently. The rest of the request's options are sent as
 * written, because a hosted model's parameters are its own.
 */
export function buildMediaGenerationInput(
  request: MediaGenerationRequest
): Record<string, unknown> {
  const field = request.promptField?.trim() || MEDIA_PROMPT_INPUT_FIELD
  return { ...(request.options ?? {}), [field]: request.prompt }
}
