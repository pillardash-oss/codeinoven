/**
 * Read-only discovery types for OpenCode V2 (`@opencode/cli`, the `opencode2`
 * binary). OpenCode V2 exposes an OpenAPI surface under `/api/*` that is
 * unrelated to the v1 CLI's REST API, so its catalog is mapped into its own
 * shape instead of reusing the v1 provider/model types.
 *
 * These are plain data: they cross the IPC boundary to the renderer.
 */

/** Identity the V2 server reports about itself (`GET /api/info`). */
export interface OpenCodeV2ServerIdentity {
  version: string
  pid: number
  urls: string[]
}

/** One provider the V2 server knows about (`GET /api/provider`). */
export interface OpenCodeV2ProviderEntry {
  id: string
  name: string
  activation: 'auto' | 'enabled' | 'disabled'
  package: string
  integrationId?: string
}

/** One model offered by a provider (`GET /api/model`). */
export interface OpenCodeV2ModelEntry {
  id: string
  modelId: string
  providerId: string
  name: string
  family?: string
  status: 'alpha' | 'beta' | 'deprecated' | 'active'
  enabled: boolean
  /** Provider-reported context window in tokens. */
  contextLimit: number
  /** Provider-reported maximum output in tokens. */
  outputLimit: number
  /** Whether the model accepts tool calls. */
  tools: boolean
  /** Input modalities, e.g. `text`, `image`, `audio`. */
  inputs: string[]
  /** Output modalities, e.g. `text`. */
  outputs: string[]
}

/** One agent configured on the V2 server (`GET /api/agent`). */
export interface OpenCodeV2AgentEntry {
  id: string
  name: string
  description?: string
  mode: 'primary' | 'subagent' | 'all'
  hidden: boolean
}

/** A complete read-only snapshot of an installed OpenCode V2 server. */
export interface OpenCodeV2Catalog {
  server: OpenCodeV2ServerIdentity
  providers: OpenCodeV2ProviderEntry[]
  models: OpenCodeV2ModelEntry[]
  agents: OpenCodeV2AgentEntry[]
  /** Epoch ms the snapshot was captured. */
  fetchedAt: number
}

/**
 * Result of a catalog discovery attempt. An expected failure (binary missing,
 * server unreachable, wrong version) crosses IPC as data instead of a rejected
 * invoke, so the UI can render it without an error boundary.
 */
export type OpenCodeV2DiscoveryResult =
  | { ok: true; catalog: OpenCodeV2Catalog }
  | { ok: false; reason: OpenCodeV2DiscoveryFailureReason; detail: string }

export type OpenCodeV2DiscoveryFailureReason =
  'not-installed' | 'unsupported-version' | 'unreachable'
