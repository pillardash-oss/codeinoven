import type { Contract } from './contract-helpers'

export const invokeSearchContract = {
  'search:getState': {} as Contract<[], import('../search/types').SearchState>,
  /**
   * Boot the local embedding model in the background so the next Cmd+K thread
   * search does not pay the load. A no-op unless intent search is enabled with a
   * loadable model.
   */
  'search:warm': {} as Contract<[], void>,
  'search:downloadArtifact': {} as Contract<[artifactId: string], void>,
  'search:cancelDownload': {} as Contract<[artifactId: string], boolean>,
  'search:deleteModel': {} as Contract<[modelId: string], void>,
  /** Opens a native file picker for a local embedding model; null when cancelled. */
  'search:pickModelFile': {} as Contract<[], string | null>,
  'search:importModel': {} as Contract<
    [path: string],
    import('../search/types').InstalledSearchModel
  >,
  /** Validates a pasted local model path without importing it. */
  'search:validateModelPath': {} as Contract<
    [path: string],
    import('../speech/types').ModelPathValidationResult
  >,
  /** Sets the embedding context window, in tokens. */
  'search:setContextTokens': {} as Contract<[tokens: number], void>,
  'search:setEnabled': {} as Contract<[enabled: boolean], void>,
  'search:setActiveModel': {} as Contract<[modelId: string | null], void>,
  'search:rebuildIndex': {} as Contract<[], void>
}
