import { registerCloudDeploymentAccountHandlers } from './cloud-handlers/cloud-handlers-accounts'
import {
  createCloudDeploymentConfigStore,
  registerCloudDeploymentConfigHandlers
} from './cloud-handlers/cloud-handlers-deployment-config'
import { registerCheckpointHandlers } from './cloud-handlers/cloud-handlers-checkpoints'
import { registerGithubAuthHandlers } from './cloud-handlers/cloud-handlers-github-auth'
import { registerCloudDeploymentMonitoringHandlers } from './cloud-handlers/cloud-handlers-monitoring'
import { registerPluginHandlers } from './cloud-handlers/cloud-handlers-plugins'
import { registerProjectEditorHandlers } from './cloud-handlers/cloud-handlers-project-editor'
import { registerPullRequestHandlers } from './cloud-handlers/cloud-handlers-pr'
import { registerUtilityHandlers } from './cloud-handlers/cloud-handlers-utilities'
import type { IpcHandlerContext } from './context'

/**
 * Composition root for the cloud surface: cloud deployment config, the global
 * provider account registry, container monitoring, pull requests, plugins,
 * skill market utilities, GitHub auth and thread checkpoints. Each concern
 * lives in `./cloud-handlers/` and keeps its own channel group.
 */
export function registerCloudHandlers(ctx: IpcHandlerContext): void {
  const cloudDeploymentConfig = createCloudDeploymentConfigStore(ctx)
  registerCloudDeploymentConfigHandlers(ctx, cloudDeploymentConfig)
  registerCloudDeploymentAccountHandlers(ctx, cloudDeploymentConfig)
  registerCloudDeploymentMonitoringHandlers(ctx, cloudDeploymentConfig)
  registerPullRequestHandlers(ctx)
  registerPluginHandlers(ctx)
  registerUtilityHandlers(ctx)
  registerGithubAuthHandlers(ctx)
  registerCheckpointHandlers(ctx)
  registerProjectEditorHandlers(ctx)
}
