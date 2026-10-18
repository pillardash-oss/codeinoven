import CioDisplay from '@codeinoven/icons/CioDisplay.svelte'
import CioMemory from '@codeinoven/icons/CioMemory.svelte'
import CioPerson from '@codeinoven/icons/CioPerson.svelte'
/** Shared icons and quiet styling for attribution badges on the conversation screen. */
export const CONVERSATION_METADATA_ICONS = {
  account: CioPerson,
  local: CioDisplay,
  thinking: CioMemory
} as const

export const CONVERSATION_METADATA_BADGE_CLASS =
  'flex shrink-0 items-center gap-1 text-[0.5625rem] text-dimmed'
