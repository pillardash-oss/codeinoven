import { effectiveExperts, type EffectiveExperts } from '../../../lib/experts'
import type { ExpertSettingsService } from '../../design/expert-settings-service'
import type { AgentCapabilitySource } from '../../../lib/types'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine utilities-mcp: one concern, moved verbatim from the composition root. */
export class ChatEngineUtilitiesMcp {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Register the thread-scoped expert policy.
   *
   * It answers two questions that have to agree: what the playbook tells a
   * session about the models the user staffed, and whether `delegate` will run
   * one of them. Both are asked of this service, so a thread the user muted is
   * neither described as staffed nor allowed to delegate.
   */
  setExpertSettings(settings: ExpertSettingsService | null): void {
    this.host.state.expertSettings = settings
    this.host.state.utilityOrchestration.setExpertSettings(settings)
  }

  /**
   * The experts a thread's session may delegate to.
   *
   * Falls back to the raw config when no policy is wired, which keeps a
   * service graph that never installed one working exactly as it did before
   * threads could carry an answer of their own.
   */
  async expertsForThread(threadId: string): Promise<EffectiveExperts> {
    if (this.host.state.expertSettings) return this.host.state.expertSettings.effectiveFor(threadId)
    const config = await this.host.storage.getConfig()
    return effectiveExperts(config.design?.assignments, null)
  }

  /** Delete a harness-native or app-managed skill. */
  deleteSkill(source: AgentCapabilitySource): Promise<boolean> {
    return this.host.state.capabilityDiscovery.deleteSkill(source)
  }

  /** Delete an app-managed MCP server entry. */
  deleteMcp(source: AgentCapabilitySource): Promise<boolean> {
    return this.host.state.capabilityDiscovery.deleteMcp(source)
  }
}
