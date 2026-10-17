import CioDisplay from '$lib/components/icons/cio/CioDisplay.svelte'
import CioMemory from '$lib/components/icons/cio/CioMemory.svelte'
import CioPerson from '$lib/components/icons/cio/CioPerson.svelte'
/** Shared icons and quiet styling for attribution badges on the conversation screen. */
export const CONVERSATION_METADATA_ICONS = {
  account: CioPerson,
  local: CioDisplay,
  thinking: CioMemory
} as const

export const CONVERSATION_METADATA_BADGE_CLASS =
  'flex shrink-0 items-center gap-1 text-[0.5625rem] text-dimmed'
