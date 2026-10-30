import type { ImageDescriptorExecutorRequest } from '../../providers/image-descriptor-provider'
import {
  IMAGE_DESCRIPTOR_BATCH_MAX_IMAGES,
  imageDescriptorBatchCapability
} from '../../services/image-descriptor'
import type { ImageDescriptorBatchCapability } from '../../services/image-descriptor'
import type { AgentModelSelection } from '../../../lib/types'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine utilities-gateway: one concern, moved verbatim from the composition root. */
export class ChatEngineUtilitiesGateway {
  constructor(private readonly host: ChatEngine) {}

  /** Whether the pinned harness can batch several images into one vision call. */
  async imageDescriptorBatchCapability(
    request: ImageDescriptorExecutorRequest,
    selection: AgentModelSelection
  ): Promise<ImageDescriptorBatchCapability> {
    const account = await this.host.state.accountRegistry.resolveForProvider(
      selection.harnessId,
      selection.providerId,
      selection.accountId
    )
    const { driver } = await this.host.resolve(
      request.projectId,
      selection.harnessId,
      request.threadId,
      account.id
    )
    if (!driver.capabilities) {
      return { supportsBatch: false, maxImages: IMAGE_DESCRIPTOR_BATCH_MAX_IMAGES }
    }
    return imageDescriptorBatchCapability(driver.capabilities, IMAGE_DESCRIPTOR_BATCH_MAX_IMAGES)
  }
}
