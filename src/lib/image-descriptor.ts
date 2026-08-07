/**
 * Shared image-descriptor contract used by the app tool catalog
 * (`APPLICATION_AGENT_TOOLS`) and the main-process vision executor. Lives in
 * `lib` so the tool definition and the wire schema never drift apart.
 */

/** Stable application-facing name for the image descriptor tool. */
export const IMAGE_DESCRIPTOR_TOOL_NAME = 'image_descriptor'

/** How the image source should be interpreted. */
export type ImageDescriptorSourceType = 'part' | 'binary'

/** One image requested for description. `source` is a file path / file URL /
 *  http(s) URL / data URL when `type` is `part`, or base64 (or a data URL)
 *  when `type` is `binary`. Each entry carries a unique `id` so responses can
 *  be mapped back to the request. */
export interface ImageDescriptorEntry {
  id: string
  source: string
  type: ImageDescriptorSourceType
}

/** Maximum images accepted in one call. */
export const IMAGE_DESCRIPTOR_MAX_IMAGES = 8

/** Exhaustive description instruction given to the vision model. */
export const IMAGE_DESCRIPTOR_PROMPT =
  'Describe this image exhaustively, in a structured reading order from the top-left corner to the bottom-right corner across the entire image, so that another model can use this description for a mission-critical operation. Ensure no detail is skipped. Describe every single thing that you can identify: layout, subjects and objects, people, actions, text verbatim, colors, spatial relationships, textures, lighting, and any anomalies or edges.'

export const IMAGE_DESCRIPTOR_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description:
    'Describe one or more images using a vision-capable model so a text-only model can reason about them. Provide every image entry with a unique id.',
  properties: {
    images: {
      type: 'array',
      minItems: 1,
      maxItems: IMAGE_DESCRIPTOR_MAX_IMAGES,
      description:
        'Images to describe. Each entry has a unique id, a source, and a type: "part" when source is a file path or URL the model can read, or "binary" when source is base64 image data.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            maxLength: 256,
            description: 'Unique id used to tag this entry in the response.'
          },
          source: {
            type: 'string',
            minLength: 1,
            description:
              'File path, file:// URL, http(s) URL, or data URL when type is "part"; base64 image data or a data URL when type is "binary".'
          },
          type: {
            type: 'string',
            enum: ['part', 'binary'],
            description:
              'How to read the source: "part" reads it as a file/URL reference, "binary" decodes it as base64 image data.'
          }
        },
        required: ['id', 'source', 'type']
      }
    }
  },
  required: ['images']
}

export const IMAGE_DESCRIPTOR_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          type: { type: 'string', enum: ['part', 'binary'] },
          description: { type: 'string' },
          error: { type: 'string' }
        },
        required: ['id', 'source', 'type', 'description']
      }
    }
  },
  required: ['results']
}
