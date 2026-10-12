/**
 * Intent (semantic) thread search — shared domain types.
 *
 * The app keeps two indexes over the same corpus: the existing full-text index
 * (`agent_messages_fts` plus the thread title match) and, once enabled, an
 * embedding index over each thread. Keyword search stays the default; enabling
 * intent search makes every thread search hybrid (keyword + intent).
 */

/** Local runtime that executes an embedding model. `gguf` is llama.cpp. */
export type EmbeddingRuntimeId = 'gguf' | 'mlx' | 'coreml'

export type SearchPlatform = 'darwin' | 'win32' | 'linux'
export type SearchArchitecture = 'arm64' | 'x64'

/** One downloadable file of a search model artifact. */
export interface SearchModelFile {
  /** Path inside the model directory (safe, artifact-relative). */
  path: string
  sourceUrl: string
  byteSize: number
  sha256: string
}

/**
 * A catalog entry for an embedding model. Runtime-aware so a listing is never
 * gguf-only: an artifact is offered only when its runtime is available on the
 * current machine.
 */
export interface SearchModelArtifact {
  id: string
  runtime: EmbeddingRuntimeId
  label: string
  description: string
  quantization: string
  /** Output dimensionality of the embedding vector. */
  dimensions: number
  /** Model's usable input window, in tokens. */
  contextTokens: number
  /** Prompt prepended to a search query before embedding. */
  queryPrefix: string
  /** Prompt prepended to indexed document text before embedding. */
  documentPrefix: string
  platforms: readonly SearchPlatform[]
  architectures: readonly SearchArchitecture[]
  files: readonly SearchModelFile[]
  byteSize: number
  license: string
  attribution: string
  sourcePageUrl: string
  minimumMemoryBytes: number
}

/** A model the user has on disk, either downloaded from the catalog or imported. */
export interface InstalledSearchModel {
  id: string
  artifactId: string | null
  label: string
  runtime: EmbeddingRuntimeId
  dimensions: number
  contextTokens: number
  queryPrefix: string
  documentPrefix: string
  byteSize: number
  installedAt: number
  directory: string
  source: 'catalog' | 'imported'
}

export interface SearchSettings {
  /** Whether intent search is active. Only meaningful once a model is installed. */
  enabled: boolean
  /** Installed model id used for embedding, or null when none is selected. */
  activeModelId: string | null
}

export const DEFAULT_SEARCH_SETTINGS: SearchSettings = {
  enabled: false,
  activeModelId: null
}

export type SearchDownloadState =
  | { state: 'downloading'; bytesReceived: number; totalBytes: number }
  | { state: 'verifying'; bytesReceived: number; totalBytes: number }
  | { state: 'installed'; installedAt: number }
  | { state: 'cancelled'; cancelledAt: number }
  | { state: 'failed'; failedAt: number; message: string }

/** Live indexing + capability status for the Search settings page. */
export interface SearchIndexStatus {
  /** Intent search is enabled and a model is ready to embed with. */
  active: boolean
  /** The llama.cpp (or other) runtime the active model needs is available. */
  runtimeAvailable: boolean
  /** An installed model is selected and resident. */
  modelReady: boolean
  activeModelId: string | null
  indexedThreads: number
  pendingThreads: number
  indexing: boolean
  dimensions: number
  lastIndexedAt: number | null
}

export interface SearchState {
  settings: SearchSettings
  status: SearchIndexStatus
  models: readonly InstalledSearchModel[]
  catalog: readonly SearchModelArtifact[]
  /** Live download progress per catalog artifact id. */
  downloads: Readonly<Record<string, SearchDownloadState>>
}

export type SearchProgressEvent =
  | { kind: 'download'; artifactId: string; download: SearchDownloadState }
  | { kind: 'status'; status: SearchIndexStatus }

/** A vector persisted for one thread, with the content hash that produced it. */
export interface ThreadEmbeddingRecord {
  threadId: string
  contentHash: string
  dimensions: number
  updatedAt: number
  vector: Float32Array
}

/** One thread that surfaced from intent search, before it is hydrated. */
export interface IntentThreadMatch {
  threadId: string
  score: number
}
