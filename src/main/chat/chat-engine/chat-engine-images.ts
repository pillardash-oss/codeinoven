import type { ImageDescriptorResult } from '../../providers/image-descriptor-provider'
import type { AgentModelSelection, PromptAttachment } from '../../../lib/types'

/** Whether two agent model selections identify the same vision model. */
export function isSameImageDescriptorModel(
  a: AgentModelSelection | undefined,
  b: AgentModelSelection
): boolean {
  return (
    a !== undefined &&
    a.harnessId === b.harnessId &&
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.accountId === b.accountId
  )
}

export function isImagePromptAttachment(attachment: PromptAttachment): boolean {
  if (attachment.mime.toLocaleLowerCase().startsWith('image/')) return true
  const candidate = attachment.filename ?? attachment.url
  return /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/iu.test(candidate)
}

export function imageDescriptionSource(source: string): string {
  return source.startsWith('data:') ? '[attached binary image]' : source
}

export function formatAttachedImageDescriptions(results: readonly ImageDescriptorResult[]): string {
  if (results.length === 0) return ''
  const evidence = results.map((result) => ({
    id: result.id,
    source: imageDescriptionSource(result.source),
    description: result.description,
    ...(result.error ? { error: result.error } : {})
  }))
  return [
    'Image evidence generated before dispatch by the configured vision model:',
    JSON.stringify(evidence, null, 2),
    'Use this evidence when answering the user. For follow-up inspection, search for the image-descriptor utility (kinds ["image_descriptor"]) through the app gateway, activate it, and invoke its describe operation.'
  ].join('\n\n')
}

/** Parse the assistant's text into the batched descriptor object, tolerating a
 *  surrounding JSON code fence. Throws a clear error when the output is not a
 *  JSON object so the caller can safely fall back to per-image calls instead of
 *  mislabeling any image. */
export function parseBatchedDescriptorJson(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*/u, '')
    .replace(/```\s*$/u, '')
    .trim()
  try {
    const parsed: unknown = JSON.parse(cleaned)
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    // Fall through to the explicit error below.
  }
  throw new Error(
    'The vision model returned output that could not be read as the batched image description result.'
  )
}
