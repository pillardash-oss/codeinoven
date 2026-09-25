import { invoke } from '$lib/ipc.svelte'
import type { AttachmentStorageScope } from '$shared/types'

const MAX_PROMPT_CHARACTERS = 200_000
const LONG_PASTE_ATTACHMENT_CHARACTERS = 100_000

export interface ComposerPasteContext {
  getReadOnlyMode(): boolean
  getAllowAttachments(): boolean
  getValue(): string
  getAttachmentStorage(): AttachmentStorageScope | undefined
  getSelectedHarnessLacksAttachments(): boolean
  addPastedTextAttachment(text: string): Promise<void>
  addFileAttachment(filePath: string, file?: File): Promise<void>
  setTextAttachmentError(message: string): void
  setAttachmentBlockedNotice(value: boolean): void
}

/**
 * Composer paste handling: long pastes (or drafts that would overflow the
 * prompt cap) become text attachments, then file items and clipboard images
 * are attached in that order.
 */
export async function handleComposerPaste(
  e: ClipboardEvent,
  ctx: ComposerPasteContext
): Promise<void> {
  if (ctx.getReadOnlyMode() && !ctx.getAllowAttachments()) return
  const pastedText = e.clipboardData?.getData('text/plain') ?? ''
  const shouldAttachText =
    pastedText.length >= LONG_PASTE_ATTACHMENT_CHARACTERS ||
    ctx.getValue().length + pastedText.length > MAX_PROMPT_CHARACTERS
  if (
    shouldAttachText &&
    pastedText.length > 0 &&
    ctx.getAttachmentStorage() &&
    !ctx.getSelectedHarnessLacksAttachments()
  ) {
    e.preventDefault()
    ctx.setTextAttachmentError('')
    try {
      await ctx.addPastedTextAttachment(pastedText)
    } catch (error) {
      ctx.setTextAttachmentError(
        error instanceof Error ? error.message : 'The pasted text could not be attached.'
      )
    }
    return
  }
  const items = e.clipboardData?.items
  if (!items) return
  if (ctx.getSelectedHarnessLacksAttachments()) {
    const hasFile = Array.from(items).some(
      (item) => item.kind === 'file' || item.type.startsWith('image/')
    )
    if (hasFile) {
      e.preventDefault()
      ctx.setAttachmentBlockedNotice(true)
    }
    return
  }
  let hasFileAttachment = false

  for (const item of Array.from(items)) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file) {
        try {
          const filePath = await window.api.registerFileSelection(file, ctx.getAttachmentStorage())
          if (filePath) {
            await ctx.addFileAttachment(filePath, file)
            hasFileAttachment = true
          }
        } catch {
          // Pasted item is not a local file; fall through to clipboard image handler.
        }
      }
    }
  }

  if (!hasFileAttachment) {
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        hasFileAttachment = true
        break
      }
    }
    if (hasFileAttachment) {
      const scope = ctx.getAttachmentStorage()
      try {
        const path = scope ? await invoke('clipboard:saveImage', scope) : null
        if (path) await ctx.addFileAttachment(path)
        else hasFileAttachment = false
      } catch {
        hasFileAttachment = false
      }
    }
  }

  if (hasFileAttachment) e.preventDefault()
}
