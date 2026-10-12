import type { Contract } from './contract-helpers'

export const invokeSearchContract = {
  'search:getState': {} as Contract<[], import('../search/types').SearchState>,
  'search:downloadArtifact': {} as Contract<[artifactId: string], void>,
  'search:cancelDownload': {} as Contract<[artifactId: string], boolean>,
  'search:deleteModel': {} as Contract<[modelId: string], void>,
  /** Opens a native file picker for a local embedding model; null when cancelled. */
  'search:pickModelFile': {} as Contract<[], string | null>,
  'search:importModel': {} as Contract<
    [path: string],
    import('../search/types').InstalledSearchModel
  >,
  'search:setEnabled': {} as Contract<[enabled: boolean], void>,
  'search:setActiveModel': {} as Contract<[modelId: string | null], void>,
  'search:rebuildIndex': {} as Contract<[], void>
}
