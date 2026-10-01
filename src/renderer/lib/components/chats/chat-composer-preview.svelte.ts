import { invoke } from '$lib/ipc.svelte'
import { attachmentPreviewKind, fileUrlToPath } from '$lib/mime'
import type { PromptAttachment } from '$shared/types'

/**
 * Attachment preview cache for the composer, and for the non-media attachments a
 * sent message carries (PDF, document, Markdown, plain text).
 *
 * Binary media are held as blob (object) URLs, Word/ODT/PPTX documents as
 * converted HTML, and markdown/plain text as decoded strings. Everything is
 * keyed by the attachment's `file://` URL so one file maps to one cache entry.
 */
export function createComposerAttachmentPreview() {
  let file = $state<PromptAttachment | null>(null)
  /** Object URLs for image/PDF/media/document downloads, keyed by attachment file:// URL. */
  let urls = $state<Record<string, string>>({})
  /** Decoded text content for markdown/plain-text previews, keyed by url. */
  let texts = $state<Record<string, string>>({})
  /** Converted Word document HTML, loaded only when the preview is opened. */
  let documents = $state<Record<string, string>>({})
  let documentLoading = $state<Record<string, boolean>>({})

  /** Loads the preview payload for one attachment: blob URLs for binary media,
   *  converted document HTML (DOCX, DOC, ODT, PPTX), or decoded text. Missing/
   *  undecodable files silently yield no preview so the chip falls back to the
   *  file:// URL or the modal shows its unavailable state. */
  async function load(attachment: PromptAttachment): Promise<void> {
    const kind = attachmentPreviewKind(attachment.mime, attachment.filename ?? '')
    if (!kind) return
    if (kind === 'document' && file?.url !== attachment.url) return
    try {
      const filePath = fileUrlToPath(attachment.url)
      if (kind === 'document') {
        if (documents[attachment.url] !== undefined && urls[attachment.url]) return
        if (documentLoading[attachment.url]) return
        documentLoading = { ...documentLoading, [attachment.url]: true }
        const html = await invoke('file:readDocumentPreview', filePath)
        if (!html) return
        documents = { ...documents, [attachment.url]: html }
        if (!urls[attachment.url]) {
          const bytes = await window.api.readFile(filePath)
          const objectUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }))
          urls = { ...urls, [attachment.url]: objectUrl }
        }
        return
      }
      const bytes = await window.api.readFile(filePath)
      if (kind === 'markdown' || kind === 'text') {
        if (texts[attachment.url] !== undefined) return
        texts = { ...texts, [attachment.url]: new TextDecoder().decode(bytes) }
        return
      }
      if (urls[attachment.url]) return
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: attachment.mime }))
      urls = { ...urls, [attachment.url]: objectUrl }
    } catch {
      // Preview unavailable; the chip/modal will fall back to the file:// URL.
    } finally {
      if (kind === 'document') {
        documentLoading = { ...documentLoading, [attachment.url]: false }
      }
    }
  }

  function open(attachment: PromptAttachment): void {
    file = attachment
    void load(attachment)
  }

  async function loadAll(files: PromptAttachment[]): Promise<void> {
    for (const attachment of files) {
      await load(attachment)
    }
  }

  function close(): void {
    file = null
  }

  function setText(url: string, text: string): void {
    texts = { ...texts, [url]: text }
  }

  /** Drop every cache entry (and revoke the blob URL) for one attachment. */
  function clear(url: string): void {
    const objectUrl = urls[url]
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      const rest = { ...urls }
      delete rest[url]
      urls = rest
    }
    const restTexts = { ...texts }
    delete restTexts[url]
    texts = restTexts
    const restDocuments = { ...documents }
    delete restDocuments[url]
    documents = restDocuments
    const restLoading = { ...documentLoading }
    delete restLoading[url]
    documentLoading = restLoading
  }

  function revokeAll(): void {
    for (const objectUrl of Object.values(urls)) {
      URL.revokeObjectURL(objectUrl)
    }
  }

  /** Revoke every blob URL and drop the whole cache (after a send clears the
   *  attachment list). */
  function reset(): void {
    revokeAll()
    urls = {}
    texts = {}
    documents = {}
    documentLoading = {}
  }

  return {
    get file() {
      return file
    },
    get urls() {
      return urls
    },
    get texts() {
      return texts
    },
    get documents() {
      return documents
    },
    get documentLoading() {
      return documentLoading
    },
    open,
    load,
    loadAll,
    close,
    setText,
    clear,
    revokeAll,
    reset
  }
}
