import { acpAgentsStore } from '$lib/stores/acp-agents.svelte'
import { getAgentIcon } from './registry'

/**
 * The name a harness is shown by, for every label the user reads.
 *
 * A harness the app knows is named by the agent registry. A harness the user
 * added themselves is named by them, and only ever falls back to its id when
 * that agent is not readable (or was removed), because an id like
 * `acp-cursor-agent-2` is an implementation detail the user never chose.
 */
export function agentDisplayName(harnessId: string): string {
  if (harnessId.startsWith('acp-')) {
    const configured = acpAgentsStore.nameFor(harnessId)
    if (configured) return configured
    // The first label can be read before the agent list has landed. Asking for
    // it here means the row re-renders with the user's name as soon as it does,
    // instead of keeping the id it was first given.
    void acpAgentsStore.load()
  }
  return getAgentIcon(harnessId)?.name ?? harnessId
}
