import type { PromptAttachment } from '../../../lib/types'
import { resolveFastModelId } from '../../../lib/fast-inference'
import type { SendPromptOptions } from '../driver.interface'
import { materializeAttachment } from '../attachment-data-url'
import {
  isDocumentAttachment,
  formatDocumentAsText,
  readDocumentText
} from '../document-attachment'
import { formatSvgAsText, isSvgAttachment, readSvgAttachmentText } from '../svg-attachment'
import { formatTextAsText, isTextAttachment, readTextAttachment } from '../text-attachment'
import { opencodePermissionTools } from './opencode-models'

/**
 * Build OpenCode prompt parts, inlining SVG, text, and document attachments as
 * text because the backend's default decoder cannot rasterize them.
 *
 * An embedded `data:` payload or a remote `http(s)` source is staged in
 * `scratchDirectory` first and dispatched as a file part: the backend resolves a
 * file part's URL with `Bun.file`, which reads the whole `data:...` or
 * `http://...` string as a filesystem path and fails with ENOENT before the
 * model ever sees the image.
 */
export async function buildOpenCodePromptParts(
  attachments: readonly PromptAttachment[],
  scratchDirectory?: string
): Promise<Array<Record<string, unknown>>> {
  const parts: Array<Record<string, unknown>> = []
  for (const attachment of attachments) {
    const resolved =
      scratchDirectory === undefined
        ? attachment
        : await materializeAttachment(attachment, scratchDirectory)
    if (isSvgAttachment(resolved)) {
      // The opencode backend rasterizes image parts and its default decoder
      // cannot decode SVG, so inline the raw markup as text instead.
      const content = await readSvgAttachmentText(resolved)
      if (content !== null) {
        parts.push({ type: 'text', text: formatSvgAsText(resolved, content) })
        continue
      }
    }
    if (isTextAttachment(resolved)) {
      // Some providers reject file parts whose media type they do not
      // support (e.g. application/json), so inline text-ish content instead.
      const content = await readTextAttachment(resolved)
      if (content !== null) {
        parts.push({ type: 'text', text: formatTextAsText(resolved, content) })
        continue
      }
    }
    if (isDocumentAttachment(resolved)) {
      const content = await readDocumentText(resolved)
      if (content !== null) {
        parts.push({ type: 'text', text: formatDocumentAsText(resolved, content) })
        continue
      }
    }
    parts.push({
      type: 'file',
      mime: resolved.mime,
      url: resolved.url,
      filename: resolved.filename
    })
  }
  return parts
}

/** Assemble the OpenCode `prompt_async` request body for a turn. */
export function buildOpenCodePromptBody(
  opts: SendPromptOptions,
  parts: Array<Record<string, unknown>>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    variant: opts.settings.thinkingLevel,
    parts
  }
  if (opts.userMessageId) {
    body['messageID'] = opts.userMessageId
  }
  const model = {
    providerId: opts.settings.providerId,
    modelId: resolveFastModelId(opts.settings.modelId, opts.settings.inferenceMode)
  }
  if (model.providerId && model.modelId) {
    body['model'] = {
      providerID: model.providerId,
      modelID: model.modelId
    }
  }
  if (opts.systemPrompt) {
    body['system'] = opts.systemPrompt
  }
  const tools = opencodePermissionTools(opts)
  if (tools !== undefined) {
    body['tools'] = tools
  }
  if (opts.agent) {
    body['agent'] = opts.agent
  }
  if (opts.structuredOutput) {
    body['format'] = {
      type: 'json_schema',
      schema: opts.structuredOutput.schema,
      retryCount: opts.structuredOutput.retryCount
    }
  }
  return body
}
