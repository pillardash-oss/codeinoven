import type { AgentContextUsage, AgentHarnessUsage, UsageEfficiencyKpis } from '$shared/types'

/**
 * What the context holds, as the composer's shoe states it: the five-cell meter
 * and its number, drawn by `ContextUsageIndicator` before the tips. The composer
 * owns this reading, so it does not travel through `ComposerShoeData`, which the
 * host builds.
 *
 * The type lives here rather than in the component so a plain module, and every
 * controller the composer is split into, can name it.
 */
export interface ComposerUsage {
  usage?: AgentContextUsage
  previewContextWindow?: number
  generationRate?: number | null
  generationDetails?: import('$lib/generation-details').GenerationDetails
  efficiencyKpis?: UsageEfficiencyKpis
  harnessUsage?: AgentHarnessUsage[]
  canCompact?: boolean
  compacting?: boolean
  onCompact?: () => void
  onActivateBankedReset?: () => void
  onReveal?: () => void
  onHide?: () => void
  refreshing?: boolean
}
