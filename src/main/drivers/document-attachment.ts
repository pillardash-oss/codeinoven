import type { PromptAttachment } from '../../lib/types'
import { backgroundIo } from '../system/background-io'
export { isDocumentAttachment, formatDocumentAsText } from './document-attachment-meta'

/** Parsing and archive expansion run in the bounded worker, never on Electron's main thread. */
export function readDocumentText(attachment: PromptAttachment): Promise<string | null> {
  return backgroundIo<string | null>({ kind: 'document', attachment, preview: false }).catch(
    () => null
  )
}
export function readDocumentPreviewHtml(attachment: PromptAttachment): Promise<string | null> {
  return backgroundIo<string | null>({ kind: 'document', attachment, preview: true }).catch(
    () => null
  )
}
