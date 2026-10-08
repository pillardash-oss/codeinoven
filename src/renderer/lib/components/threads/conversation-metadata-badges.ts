import { Brain, Monitor, UserRound } from '@lucide/svelte'

/** Shared icons and quiet styling for attribution badges on the conversation screen. */
export const CONVERSATION_METADATA_ICONS = {
  account: UserRound,
  local: Monitor,
  thinking: Brain
} as const

export const CONVERSATION_METADATA_BADGE_CLASS =
  'flex shrink-0 items-center gap-1 text-[0.5625rem] text-dimmed'
