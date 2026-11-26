/**
 * How long a resident local model stays loaded after its last use.
 *
 * This is its own module, not part of `llama-cpp.ts`, because the renderer's
 * baseline config (`app-defaults.ts`) needs exactly one value from here and
 * nothing else the Local AI page owns. Reading the default through the big
 * module dragged the whole server-entry model, its validators, and the brew and
 * launch helpers of both engines onto the first screen, where none of them can
 * be used: the page that reads them is opened on demand. `llama-cpp.ts` still
 * re-exports every name below, so the public surface is unchanged.
 */

/**
 * One window for every local server the app owns: the same model is held for
 * speech cleanup and for search embeddings, so two windows would only decide
 * which subsystem re-loads it first. `keep` pins it for the rest of the session.
 */
export const LOCAL_AI_UNLOAD_OPTIONS = ['5m', '10m', '20m', '30m', 'keep'] as const

export type LocalAiUnloadOption = (typeof LOCAL_AI_UNLOAD_OPTIONS)[number]

/** 30 minutes: long enough to stay warm across a working session. */
export const DEFAULT_LOCAL_AI_UNLOAD_OPTION: LocalAiUnloadOption = '30m'

const LOCAL_AI_UNLOAD_MS: Readonly<Record<Exclude<LocalAiUnloadOption, 'keep'>, number>> = {
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '20m': 20 * 60_000,
  '30m': 30 * 60_000
}

export const LOCAL_AI_UNLOAD_LABELS: Readonly<Record<LocalAiUnloadOption, string>> = {
  '5m': '5 minutes',
  '10m': '10 minutes',
  '20m': '20 minutes',
  '30m': '30 minutes',
  keep: 'Never unload'
}

export function isLocalAiUnloadOption(value: unknown): value is LocalAiUnloadOption {
  return typeof value === 'string' && LOCAL_AI_UNLOAD_OPTIONS.some((option) => option === value)
}

/** A stored value that is no longer a valid option falls back to the default. */
export function readLocalAiUnloadOption(value: unknown): LocalAiUnloadOption {
  return isLocalAiUnloadOption(value) ? value : DEFAULT_LOCAL_AI_UNLOAD_OPTION
}

/** How long the window lasts, or null when the user pinned the model. */
export function localAiUnloadMs(option: LocalAiUnloadOption): number | null {
  return option === 'keep' ? null : LOCAL_AI_UNLOAD_MS[option]
}
