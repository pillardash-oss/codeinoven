import type { MemoryConfig, MemoryEntry } from '../types'
import { trackFrequency } from './frequency-tracker'

export interface ReinforcementResult {
  reinforced: boolean
  entryId: string
  newFrequency: number
  message: string
}

/**
 * Reinforce a memory entry when a violation is detected.
 * Increments the frequency and updates lastReinforced timestamp.
 */
export async function reinforceMemory(
  entryId: string,
  config: MemoryConfig,
  projectId?: string
): Promise<ReinforcementResult> {
  const entry = config.entries.find((e) => e.id === entryId)
  if (!entry) {
    return {
      reinforced: false,
      entryId,
      newFrequency: 0,
      message: `Entry ${entryId} not found.`
    }
  }

  const { count } = await trackFrequency(entry.content, projectId)

  return {
    reinforced: true,
    entryId,
    newFrequency: count,
    message: `Memory "${entry.label}" reinforced. Frequency: ${count}.`
  }
}

/**
 * Check if a memory entry should be promoted to a higher priority
 * based on its frequency of reinforcement.
 */
export function shouldPromotePriority(entry: MemoryEntry): boolean {
  if (entry.priority === 'critical') return false
  if (entry.frequency >= 5 && entry.priority === 'low') return true
  if (entry.frequency >= 3 && entry.priority === 'medium') return true
  if (entry.frequency >= 2 && entry.priority === 'high') return true
  return false
}

/**
 * Get the recommended priority based on frequency.
 */
export function getRecommendedPriority(
  currentPriority: string,
  frequency: number
): string {
  if (frequency >= 5) return 'critical'
  if (frequency >= 3 && currentPriority !== 'critical') return 'high'
  if (frequency >= 2 && currentPriority === 'low') return 'medium'
  return currentPriority
}

/**
 * Generate a reinforcement report for the user.
 */
export function formatReinforcementReport(results: ReinforcementResult[]): string {
  if (results.length === 0) return ''

  const lines: string[] = ['**Memory Reinforcement:**']
  for (const r of results) {
    if (r.reinforced) {
      lines.push(`- ${r.message}`)
    }
  }
  return lines.join('\n')
}
