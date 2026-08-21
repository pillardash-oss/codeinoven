/**
 * Managed local gateway plugin contract.
 *
 * A gateway is a supervised, app-owned local process exposing OpenAI- and/or
 * Anthropic-compatible endpoints (OmniRoute is the first adapter). It is
 * deliberately not a `UtilityDefinition`: utilities are turn-scoped overlays,
 * while a gateway owns a persistent loopback HTTP server whose catalog is
 * synced into the harness custom-provider store.
 */

export type GatewayLifecycleState =
  | 'not_installed'
  | 'installing'
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'error'

export type GatewayAuthMode = 'none' | 'bearer'

/** Runtime used to execute the adapter's entrypoint. */
export type GatewayRuntime = 'node' | 'bun'

/** Declarative, app-reviewed adapter for one gateway distribution. */
export interface GatewayAdapterDefinition {
  /** Stable adapter id, e.g. `omniroute`. */
  id: string
  name: string
  description: string
  /** Exact npm package that is installed into the app-owned directory. */
  npmPackage: string
  /** Pinned version — never a range, so installs are reproducible. */
  version: string
  /** Package-relative path of the server entrypoint. */
  binPath: string
  runtime: GatewayRuntime
  /**
   * Fixed CLI arguments. The loopback port is always delivered via the PORT
   * env var, never argv, so both CLI and bare-server entrypoints work.
   */
  serveArgs: string[]
  /** Extra environment set on the child beyond the inherited environment. */
  env?: Record<string, string>
  /** Loopback health probe paths tried in order until one answers 2xx. */
  healthPaths: string[]
  /** OpenAI-compatible models endpoint used for catalog discovery. */
  modelsPath: string
  /** Dashboard path served by the gateway. */
  dashboardPath: string
  authMode: GatewayAuthMode
  /** Upstream project URL shown in the UI. */
  homepage: string
}

export interface GatewayPluginState {
  pluginId: string
  adapterId: string
  enabled: boolean
  lifecycle: GatewayLifecycleState
  /** Sticky preferred port; collisions fall through to the next port. */
  preferredPort: number
  /** Port the running (or last ready) instance actually bound. */
  boundPort?: number
  detail?: string
  installedVersion?: string
  lastReadyAt?: number
  updatedAt: number
}

export interface GatewayModelInfo {
  id: string
  name: string
  contextWindow?: number
  maxOutputTokens?: number
  reasoning: boolean
  vision?: boolean
}

export interface GatewayStatus {
  pluginId: string
  adapterId: string
  adapterName: string
  enabled: boolean
  lifecycle: GatewayLifecycleState
  detail?: string
  port?: number
  dashboardUrl?: string
  installedVersion?: string
  availableVersion: string
  modelCount: number
  /** Harness provider ids currently synced from this gateway. */
  syncedHarnessIds: string[]
  /** Live install/download progress while lifecycle is `installing`/`starting`. */
  progress?: GatewayInstallProgress
}

export interface GatewayInstallProgress {
  phase: 'downloading' | 'installing'
  /** 0–100; omitted while the phase has no measurable total. */
  percent?: number
  downloadedBytes?: number
  totalBytes?: number
  detail?: string
}

export interface GatewayCatalogSnapshot {
  models: GatewayModelInfo[]
  fetchedAt: number
}
