import type { AgentCapabilitySource } from '../../../lib/types'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine utilities-mcp: one concern, moved verbatim from the composition root. */
export class ChatEngineUtilitiesMcp {
  constructor(private readonly host: ChatEngine) {}

  /** Delete a harness-native or app-managed skill. */
  deleteSkill(source: AgentCapabilitySource): Promise<boolean> {
    return this.host.state.capabilityDiscovery.deleteSkill(source)
  }

  /** Delete an app-managed MCP server entry. */
  deleteMcp(source: AgentCapabilitySource): Promise<boolean> {
    return this.host.state.capabilityDiscovery.deleteMcp(source)
  }
}
