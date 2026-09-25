export type AuxiliaryFeature = 'memory' | 'title' | 'search_nudge' | 'speech_lesson'

export interface AuxiliaryUsageEntry {
  feature: AuxiliaryFeature
  inputChars: number
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  unavailableCost: boolean
  timestamp: number
}

export interface AuxiliaryUsageTotals {
  calls: number
  inputChars: number
  inputTokens: number
  outputTokens?: number
  estimatedCost: number
  unavailableCalls?: number
}

export interface AuxiliaryUsageMeasurement {
  outputTokens: number
  costUsd: number | null
  costStatus: 'known' | 'estimated' | 'unavailable'
}
