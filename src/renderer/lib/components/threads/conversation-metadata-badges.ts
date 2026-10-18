import CioDisplay from '@pillardash-oss/cio-icon/CioDisplay.svelte'
import CioMemory from '@pillardash-oss/cio-icon/CioMemory.svelte'
import CioPerson from '@pillardash-oss/cio-icon/CioPerson.svelte'
/** Shared icons and quiet styling for attribution badges on the conversation screen. */
export const CONVERSATION_METADATA_ICONS = {
  account: CioPerson,
  local: CioDisplay,
  thinking: CioMemory
} as const

export const CONVERSATION_METADATA_BADGE_CLASS =
  'flex shrink-0 items-center gap-1 text-[0.5625rem] text-dimmed'
