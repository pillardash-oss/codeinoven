import { APP_SLUG } from '$shared/brand'
import type { ThinkingLevel } from '$shared/types'

const PR_COMPOSE_AGENT_SETTINGS_KEY = `${APP_SLUG}.prComposeAgentSettings.v1`

const THINKING_LEVELS = new Set<ThinkingLevel>([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
])

export interface PrComposeAgentSelection {
  harnessId: string
  providerId: string
  modelId: string
  thinkingLevel: ThinkingLevel
}

function loadSelection(): PrComposeAgentSelection | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PR_COMPOSE_AGENT_SETTINGS_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const selection = parsed as Record<string, unknown>
    const thinkingLevel = selection['thinkingLevel']
    if (
      typeof selection['harnessId'] !== 'string' ||
      typeof selection['providerId'] !== 'string' ||
      typeof selection['modelId'] !== 'string' ||
      !selection['harnessId'] ||
      !selection['providerId'] ||
      !selection['modelId'] ||
      typeof thinkingLevel !== 'string' ||
      !THINKING_LEVELS.has(thinkingLevel as ThinkingLevel)
    ) {
      return null
    }
    return {
      harnessId: selection['harnessId'],
      providerId: selection['providerId'],
      modelId: selection['modelId'],
      thinkingLevel: thinkingLevel as ThinkingLevel
    }
  } catch {
    return null
  }
}

function persistSelection(selection: PrComposeAgentSelection): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PR_COMPOSE_AGENT_SETTINGS_KEY, JSON.stringify(selection))
  } catch {
    // Unavailable preference storage must not break the current Compose PR session.
  }
}

class PrComposeAgentSettingsStore {
  selection = $state<PrComposeAgentSelection | null>(loadSelection())

  selectModel(selection: PrComposeAgentSelection): void {
    this.selection = selection
    persistSelection(selection)
  }

  selectThinking(thinkingLevel: ThinkingLevel): void {
    if (!this.selection || this.selection.thinkingLevel === thinkingLevel) return
    this.selection = { ...this.selection, thinkingLevel }
    persistSelection(this.selection)
  }
}

/** Agent settings owned by Compose PR. Thread and chat settings never seed this store. */
export const prComposeAgentSettings = new PrComposeAgentSettingsStore()
