/**
 * Batched image-description contract. Extends the shared image-descriptor tool
 * so a compatible harness can describe several images in one structured vision
 * turn and receive an ordered, per-image result set, instead of opening one
 * disposable vision session per image.
 *
 * The execution mechanics (capability decision, single batched vision call, and
 * the sequential fallback) live in `../image-descriptor-provider`; this module
 * is the stable service surface a caller (e.g. the chat engine) imports. It
 * owns the structured batch output schema, the batch prompt that tags each
 * description with the requesting id, and the mapping from harness capabilities
 * to the batch gate, and it re-exports the orchestration unchanged so there is
 * exactly one implementation.
 */

import {
  IMAGE_DESCRIPTOR_MAX_IMAGES,
  IMAGE_DESCRIPTOR_PROMPT,
  type ImageDescriptorEntry
} from '../../lib/image-descriptor'
import type { HarnessCapabilities } from '../drivers/driver.interface'
import type { ImageDescriptorBatchCapability } from '../image-descriptor-provider'

export {
  decideImageDescriptorBatch,
  runImageDescriptorBatch,
  assembleBatchedImageDescriptorResults,
  type ImageDescriptorBatchCall,
  type ImageDescriptorBatchCapability,
  type ImageDescriptorBatchDecision,
  type ImageDescriptorBatchFallbackReason,
  type ImageDescriptorBatchMode,
  type ImageDescriptorBatchRun,
  type ImageDescriptorSingleCall,
  type ImageDescriptorResult,
  type ResolvedImageEntry
} from '../image-descriptor-provider'

/** Maximum images a single batched vision turn will accept. */
export const IMAGE_DESCRIPTOR_BATCH_MAX_IMAGES = IMAGE_DESCRIPTOR_MAX_IMAGES

/**
 * Structured output schema for a batched vision turn. Each model description is
 * tagged with the exact requesting `id` so results can be mapped back to the
 * correct input image; every result maps to one image and no image can absorb
 * another's description.
 */
export const IMAGE_DESCRIPTOR_BATCH_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      description:
        'One result per input image, in the same order, each tagged with the exact requesting id.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            description: 'The exact id of the input image this description belongs to.'
          },
          description: {
            type: 'string',
            minLength: 1,
            description: 'The exhaustive description of the image with the matching id.'
          }
        },
        required: ['id', 'description']
      }
    }
  },
  required: ['results']
}

/**
 * Build the prompt for a batched vision turn. It lists every image by its exact
 * id and position so the model can tag each description correctly and the caller
 * can map the single structured response back to ordered per-image results.
 */
export function imageDescriptorBatchPrompt(entries: readonly ImageDescriptorEntry[]): string {
  const listing = entries
    .map(
      (entry, index) => `${index + 1}. id=${entry.id}${entry.source ? ` (${entry.source})` : ''}`
    )
    .join('\n')
  return (
    `${IMAGE_DESCRIPTOR_PROMPT}\n\n` +
    `This message contains ${entries.length} image(s), presented in the numbered order below. ` +
    `Describe each image separately and tag every description with its exact id. ` +
    `Return exactly one result per id, in this order:\n${listing}`
  )
}

/**
 * Derive the batch gate from a harness's declared capabilities. A harness can
 * run a multi-image request as one vision call when it supports attaching
 * multiple images to a single request; the structured result is always parsed
 * from JSON text so structured-output support is not required. Oversized
 * requests (more than `maxImages`) keep the safe sequential fallback.
 */
export function imageDescriptorBatchCapability(
  capabilities: HarnessCapabilities,
  maxImages: number = IMAGE_DESCRIPTOR_BATCH_MAX_IMAGES
): ImageDescriptorBatchCapability {
  return {
    supportsBatch: capabilities.attachments === true,
    maxImages
  }
}
