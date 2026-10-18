/**
 * Codex's own model catalog: the context windows the CLI states for each model.
 *
 * The app never invents a window for Codex. `codex debug models` is the CLI's
 * supported dump of the catalog it actually runs with, so every window the
 * picker offers is a window Codex accepts, its first option is Codex's own
 * default, and nothing is read from a pricing feed that describes something
 * else entirely.
 */

import { numberValue, record, stringValue } from './codex-values'

export interface CodexModelWindow {
  /** `context_window`: what Codex uses when the app sends no override. */
  defaultWindow: number
  /** `max_context_window`: the largest window this model accepts. */
  maxWindow: number
}

/** Codex's windows, keyed by the model slug Codex itself reports. */
export type CodexWindowCatalog = ReadonlyMap<string, CodexModelWindow>

const EMPTY_CODEX_WINDOW_CATALOG: CodexWindowCatalog = new Map()

export function emptyCodexWindowCatalog(): CodexWindowCatalog {
  return EMPTY_CODEX_WINDOW_CATALOG
}

/** Parses `codex debug models` output. Unknown shapes yield an empty catalog. */
export function parseCodexWindowCatalog(value: unknown): CodexWindowCatalog {
  const models = record(value)?.['models']
  if (!Array.isArray(models)) return emptyCodexWindowCatalog()
  const catalog = new Map<string, CodexModelWindow>()
  for (const entry of models) {
    const model = record(entry)
    if (!model) continue
    const slug = stringValue(model['slug']) ?? stringValue(model['id'])
    const defaultWindow = positiveInteger(model['context_window'] ?? model['contextWindow'])
    if (!slug || defaultWindow === undefined) continue
    const reportedMax = positiveInteger(model['max_context_window'] ?? model['maxContextWindow'])
    catalog.set(slug, {
      defaultWindow,
      maxWindow:
        reportedMax !== undefined && reportedMax > defaultWindow ? reportedMax : defaultWindow
    })
  }
  return catalog
}

/** The windows to offer for one model, Codex's default first and its ceiling second. */
export function codexContextWindowOptions(window: CodexModelWindow | undefined): number[] {
  if (!window) return []
  return window.maxWindow > window.defaultWindow
    ? [window.defaultWindow, window.maxWindow]
    : [window.defaultWindow]
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = numberValue(value)
  return parsed !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}
