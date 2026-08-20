import { Logger } from '../system/logger'
import { layerDevHash, layerSize } from './prompt-assembler'

/**
 * Dev-only per-mode token attribution.
 *
 * Records a content-free accounting of every composed prompt and its paired
 * provider-reported usage so lightweight ChatEngine modes can be measured and
 * tightened. Episodes and totals carry ONLY normalized hashes, character
 * counts, and heuristic token estimates — never layer content. Recording is
 * inert in production builds and logs exclusively through `Logger.dev`.
 */

export type AttributionMode =
  | 'inbox-chat'
  | 'file-system-chat'
  | 'ephemeral'
  | 'image-description'
  | 'pr-compose'
  | 'brainstorm'
  | 'engineering'

/** Content-free measurement of one prompt layer. */
export interface AttributionLayerReport {
  title: string
  devHash: string
  characters: number
  estimatedTokens: number
}

/** One composed-prompt measurement for a mode, keyed for pairing with totals. */
export interface PromptAttributionEpisode {
  key: string
  mode: AttributionMode
  driverId: string
  harnessVersion?: string
  layers: AttributionLayerReport[]
  totalCharacters: number
  totalEstimatedTokens: number
}

/** Provider-reported usage paired with the matching prompt episode. */
export interface TurnUsageTotals {
  key: string
  providerId: string | null
  modelId: string | null
  reportedInputTokens: number | null
  reportedTotalTokens: number | null
}

/** Compute the content-free layer report for a piece of prompt content. */
export function attributionLayer(
  title: string,
  content: string
): AttributionLayerReport {
  const report = layerSize(content)
  return {
    title,
    devHash: layerDevHash(content),
    characters: report.characters,
    estimatedTokens: report.estimatedTokens
  }
}

/** Build a full episode from named prompt pieces without exposing content. */
export function episodeFromPieces(input: {
  key: string
  mode: AttributionMode
  driverId: string
  harnessVersion?: string
  pieces: Array<{ title: string; content: string }>
}): PromptAttributionEpisode {
  const layers = input.pieces
    .filter((piece) => piece.content.trim().length > 0)
    .map((piece) => attributionLayer(piece.title, piece.content))
  const totalCharacters = layers.reduce((sum, layer) => sum + layer.characters, 0)
  const totalEstimatedTokens = layers.reduce((sum, layer) => sum + layer.estimatedTokens, 0)
  return {
    key: input.key,
    mode: input.mode,
    driverId: input.driverId,
    ...(input.harnessVersion ? { harnessVersion: input.harnessVersion } : {}),
    layers,
    totalCharacters,
    totalEstimatedTokens
  }
}

/**
 * Inert in production: dev-only attribution must never run in packaged builds.
 * `CIO_FORCE_ATTRIBUTION=1` re-enables it for local packaged-app measurement.
 */
export function attributionEnabled(): boolean {
  if (process.env['CIO_FORCE_ATTRIBUTION'] === '1') return true
  return process.env['NODE_ENV'] !== 'production'
}

export class TokenUsageAttributionRecorder {
  private readonly pendingEpisodes = new Map<string, PromptAttributionEpisode>()

  constructor(private readonly enabled: boolean) {}

  get isEnabled(): boolean {
    return this.enabled
  }

  /** Record one composed-prompt episode, replacing any pending episode with the same key. */
  recordPromptAttribution(episode: PromptAttributionEpisode): void {
    if (!this.enabled) return
    this.pendingEpisodes.set(episode.key, episode)
    Logger.dev('token-attribution prompt episode recorded', {
      key: episode.key,
      mode: episode.mode,
      driverId: episode.driverId,
      ...(episode.harnessVersion ? { harnessVersion: episode.harnessVersion } : {}),
      layers: episode.layers,
      totalCharacters: episode.totalCharacters,
      totalEstimatedTokens: episode.totalEstimatedTokens
    })
  }

  /**
   * Pair provider-reported totals with the matching pending prompt episode and
   * log one dev-only before/after row. Missing episodes are still logged so a
   * mode whose usage is recorded without a prompt assembly is discoverable.
   */
  recordTurnTotals(totals: TurnUsageTotals): void {
    if (!this.enabled) return
    const episode = this.pendingEpisodes.get(totals.key)
    if (episode) this.pendingEpisodes.delete(totals.key)
    Logger.dev('token-attribution turn totals recorded', {
      key: totals.key,
      paired: Boolean(episode),
      mode: episode?.mode ?? null,
      providerId: totals.providerId,
      modelId: totals.modelId,
      reportedInputTokens: totals.reportedInputTokens,
      reportedTotalTokens: totals.reportedTotalTokens,
      estimatedPromptCharacters: episode?.totalCharacters ?? null,
      estimatedPromptTokens: episode?.totalEstimatedTokens ?? null
    })
  }

  /** Number of prompt episodes awaiting paired totals (tests + diagnostics). */
  pendingCount(): number {
    return this.enabled ? this.pendingEpisodes.size : 0
  }
}

/** Application-wide recorder. Dev-only by default; inert in production. */
export const tokenUsageAttribution = new TokenUsageAttributionRecorder(attributionEnabled())
