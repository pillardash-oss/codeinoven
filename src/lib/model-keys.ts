/**
 * Harness-scoped identifiers for catalog models.
 *
 * A model is uniquely identified by the (harnessId, providerId, modelId)
 * triple. Model-specific memory uses this same identity so two harnesses that
 * expose the same provider/model pair do not share a memory accidentally.
 */
export interface ParsedModelKey {
  harnessId: string
  providerId: string
  modelId: string
}

/** Build a harness-scoped model key: `harnessId:providerId:modelId`. */
export function modelKey(harnessId: string, providerId: string, modelId: string): string {
  return `${harnessId}:${providerId}:${modelId}`
}

/** Parse a harness-scoped model key. Model IDs may themselves contain colons. */
export function parseModelKey(key: string): ParsedModelKey | null {
  const segments = key.split(':')
  if (segments.length < 3 || !segments[0] || !segments[1] || !segments.slice(2).join(':')) {
    return null
  }
  return {
    harnessId: segments[0],
    providerId: segments[1],
    modelId: segments.slice(2).join(':')
  }
}

/** True when a stored key uses the current harness-scoped format. */
export function isHarnessScopedModelKey(key: string): boolean {
  return parseModelKey(key) !== null
}
