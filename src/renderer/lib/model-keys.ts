/**
 * Harness-scoped identifiers for catalog models.
 *
 * A model is uniquely identified by the (harnessId, providerId, modelId) triple:
 * two different harnesses can expose a provider and model sharing the same id,
 * so a key that omits the harness collides across harnesses. All persisted
 * model keys (favorites, recently used, audit defaults) must be harness-scoped.
 */
export interface ParsedModelKey {
  /** Present on current keys; absent on legacy `providerId:modelId` keys. */
  harnessId?: string
  providerId: string
  modelId: string
}

/** Build a harness-scoped model key: `harnessId:providerId:modelId`. */
export function modelKey(harnessId: string, providerId: string, modelId: string): string {
  return `${harnessId}:${providerId}:${modelId}`
}

/**
 * Parse a stored model key. Handles both the current 3-segment format
 * (`harnessId:providerId:modelId`) and the legacy 2-segment format
 * (`providerId:modelId`), so older persisted favorites/recent remain usable.
 */
export function parseModelKey(key: string): ParsedModelKey {
  const segments = key.split(':')
  if (segments.length >= 3) {
    return {
      harnessId: segments[0],
      providerId: segments[1],
      modelId: segments.slice(2).join(':')
    }
  }
  if (segments.length === 2) {
    return {
      harnessId: undefined,
      providerId: segments[0],
      modelId: segments[1]
    }
  }
  return { harnessId: undefined, providerId: '', modelId: key }
}

/** True when a stored key carries an explicit harness (3+ segments). */
export function isHarnessScopedModelKey(key: string): boolean {
  return key.split(':').length >= 3
}
