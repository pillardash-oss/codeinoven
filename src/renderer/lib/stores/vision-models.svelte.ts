import { SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import type { VisionModelRecord } from '$shared/types'

/** Normalize a model id the same way the main-process record does, so a model
 *  reported once matches across every harness and provider. */
function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase()
}

/**
 * Renderer mirror of the app's own vision record: model ids the user reported
 * as vision-capable even though their provider catalog does not say so. Every
 * surface that gates on vision capability (image descriptor, model picker,
 * composer attachment gate) consults this record first so a known-vision model
 * never receives unnecessary descriptor tooling.
 */
class VisionModelsState {
  ids: SvelteSet<string> = new SvelteSet()
  loaded = $state(false)

  has(modelId: string): boolean {
    return this.ids.has(normalizeModelId(modelId))
  }

  async load(): Promise<void> {
    const records: VisionModelRecord[] = await invoke('visionModels:list')
    this.ids = new SvelteSet(records.map((record) => record.id))
    this.loaded = true
  }

  /** Optimistically record a freshly reported model so dependent UI updates
   *  immediately; the durable record lives in the main process. */
  markReported(modelId: string): void {
    const id = normalizeModelId(modelId)
    if (!id || this.ids.has(id)) return
    this.ids.add(id)
  }
}

export const visionModels = new VisionModelsState()
