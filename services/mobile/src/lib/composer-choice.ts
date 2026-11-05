import type { PermissionLevel, ThreadUsage, ThinkingLevel } from '#lib/api/types'

/**
 * The composer's fixed vocabulary: the thinking presets, the two permission
 * levels, and how the context meter reads. It is a plain module so the labels,
 * the order and the meter's thresholds are stated once, and a test can read them
 * without mounting a phone.
 */

export interface ThinkingOption {
  id: ThinkingLevel
  /** The full name, as the menu states it. */
  label: string
  /** What the chip can afford to say at phone width. */
  short: string
}

/** The app's seven presets, in the order the desktop lists them. */
export const THINKING_OPTIONS: readonly ThinkingOption[] = [
  { id: 'minimal', label: 'Minimal', short: 'Minimal' },
  { id: 'low', label: 'Low', short: 'Low' },
  { id: 'medium', label: 'Medium', short: 'Medium' },
  { id: 'high', label: 'High', short: 'High' },
  { id: 'xhigh', label: 'Extra high', short: 'X-high' },
  { id: 'max', label: 'Max · high usage', short: 'Max' },
  { id: 'ultra', label: 'Ultra · highest usage', short: 'Ultra' }
]

export interface PermissionOption {
  id: PermissionLevel
  label: string
  /** The row's own ink: review is information, full access is a warning. */
  tone: 'info' | 'warn'
}

const AUTO_REVIEW: PermissionOption = { id: 'auto_review', label: 'Auto Review', tone: 'info' }

export const PERMISSION_OPTIONS: readonly PermissionOption[] = [
  AUTO_REVIEW,
  { id: 'full_access', label: 'Full Access', tone: 'warn' }
]

export const DEFAULT_THINKING: ThinkingLevel = 'medium'
export const DEFAULT_PERMISSION: PermissionLevel = 'auto_review'

export function thinkingLabel(value: ThinkingLevel | null | undefined): string {
  return THINKING_OPTIONS.find((option) => option.id === value)?.label ?? DEFAULT_THINKING
}

/** The chip's own name for the level: the full label belongs to the menu. */
export function thinkingShortLabel(value: ThinkingLevel | null | undefined): string {
  return THINKING_OPTIONS.find((option) => option.id === value)?.short ?? DEFAULT_THINKING
}

export function permissionLabel(value: PermissionLevel | null | undefined): string {
  return PERMISSION_OPTIONS.find((option) => option.id === value)?.label ?? AUTO_REVIEW.label
}

export function permissionTone(value: PermissionLevel | null | undefined): 'info' | 'warn' {
  return PERMISSION_OPTIONS.find((option) => option.id === value)?.tone ?? AUTO_REVIEW.tone
}

export type MeterLevel = 'ok' | 'warn' | 'danger'

/** How full the context is, as the meter's four cells read it. */
export function meterLevel(used: number, window: number): MeterLevel {
  if (window <= 0) return 'ok'
  const share = used / window
  if (share >= 0.85) return 'danger'
  if (share >= 0.6) return 'warn'
  return 'ok'
}

/** The percentage the meter and the panel state, never more than 100. */
export function usagePercent(usage: ThreadUsage | null): number {
  if (!usage || usage.window <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((usage.used / usage.window) * 100)))
}

/** How many of the meter's four cells are filled by this share. */
export function filledCells(percent: number): number {
  if (percent <= 0) return 0
  return Math.min(4, Math.max(1, Math.ceil((percent / 100) * 4)))
}

/** Thousands read as `2.1k` in the panel's turn line, the way the design shows it. */
export function compactTokens(value: number): string {
  if (value < 1000) return String(value)
  const thousands = value / 1000
  return thousands >= 10 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1)}k`
}

/** Cost is stored in micros so a fraction of a cent survives the round trip. */
export function formatCost(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`
}

export function formatCount(value: number): string {
  return value.toLocaleString()
}
