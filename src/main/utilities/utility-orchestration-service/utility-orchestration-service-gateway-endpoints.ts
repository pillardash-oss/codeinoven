import { createServer } from 'http'
import { APP_IMAGE_DESCRIPTOR_UTILITY_ID } from '../utility-registry-service'
import { type ImageDescriptorExecutor } from '../../providers/image-descriptor-provider'
import { appServiceRegistry } from '../../system/app-service-registry'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/** UtilityOrchestrationService gateway-endpoints: one concern, moved verbatim from the composition root. */
export class UtilityOrchestrationServiceGatewayEndpoints {
  constructor(private readonly host: UtilityOrchestrationService) {}

  /**
   * Register the executor that runs a vision model for `image_descriptor`
   * utilities. The chat engine supplies it because it owns driver sessions
   * and the resolved image-descriptor model selection.
   */
  setImageDescriptorExecutor(executor: ImageDescriptorExecutor | null): void {
    this.host.imageDescriptorExecutor = executor
  }

  /**
   * All utility turns share one loopback listener. Per-turn bearer capabilities
   * select isolated state; opening another port is never part of starting a turn.
   */
  async ensureGatewayServer(): Promise<string> {
    if (this.host.gatewayBaseUrl) return this.host.gatewayBaseUrl
    if (this.host.gatewayStarting) return this.host.gatewayStarting
    const starting = new Promise<string>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.host.units['orchestration'].handleRequest(request, response)
      })
      const fail = (error: Error): void => {
        server.close()
        reject(error)
      }
      server.once('error', fail)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', fail)
        const address = server.address()
        if (!address || typeof address === 'string') {
          fail(new Error('Utility gateway could not bind to loopback'))
          return
        }
        this.host.gatewayServer = server
        this.host.gatewayBaseUrl = `http://127.0.0.1:${address.port}`
        // The gateway is app-lifetime infrastructure, so the task manager shows
        // its loopback endpoint without offering a stop it must not honour.
        appServiceRegistry.register({
          id: 'utility-gateway',
          kind: 'server',
          name: 'Utility gateway',
          detail: 'Loopback endpoint that serves activated utilities to a turn',
          scope: 'app',
          port: address.port,
          url: this.host.gatewayBaseUrl
        })
        resolve(this.host.gatewayBaseUrl)
      })
    })
    this.host.gatewayStarting = starting
    try {
      return await starting
    } finally {
      if (this.host.gatewayStarting === starting) this.host.gatewayStarting = null
    }
  }

  // Keep the single listener for the application lifetime. Turn capabilities
  // still retire independently; idle listener shutdown must not race startup.
  async closeGatewayServer(): Promise<void> {
    const server = this.host.gatewayServer
    this.host.gatewayServer = null
    this.host.gatewayBaseUrl = null
    this.host.gatewayStarting = null
    appServiceRegistry.unregister('utility-gateway')
    if (!server) return
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve()
        return
      }
      server.close(() => resolve())
    })
  }

  /**
   * Vision model pinned by the configured image-descriptor utility, read fresh
   * from the registry at invoke time. Reading the registry (not the turn-start
   * utility snapshot) means a model the user re-pins mid-turn applies to every
   * later descriptor call in that same turn.
   */
  async pinnedImageDescriptorSelection(): Promise<
    { harnessId: string; providerId: string; modelId: string } | undefined
  > {
    const utility = await this.host.registry.get(APP_IMAGE_DESCRIPTOR_UTILITY_ID)
    if (!utility || utility.kind !== 'image_descriptor') return undefined
    if (!utility.config.providerId || !utility.config.modelId) return undefined
    return {
      harnessId: utility.config.harnessId,
      providerId: utility.config.providerId,
      modelId: utility.config.modelId
    }
  }
}
