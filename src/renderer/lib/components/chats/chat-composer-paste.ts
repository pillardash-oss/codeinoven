import { invoke } from '$lib/ipc.svelte'
import { matchesProjectFileCopy } from '$lib/project-file-copy-tags'
import type { AttachmentStorageScope } from '$shared/types'

const MAX_PROMPT_CHARACTERS = 200_000
const LONG_PASTE_ATTACHMENT_CHARACTERS = 100_000

/** A copy the app's own file tree made, as it stands on the clipboard now. */
export interface OwnFileCopy {
  /** Project-relative paths the copy tagged. */
  paths: string[]
  /** Whether the copy came from this composer's project, where its tags resolve. */
  sameProject: boolean
}

export interface ComposerPasteContext {
  getReadOnlyMode(): boolean
  getAllowAttachments(): boolean
  getValue(): string
  getAttachmentStorage(): AttachmentStorageScope | undefined
  getSelectedHarnessLacksAttachments(): boolean
  getOwnFileCopy(): OwnFileCopy | null
  addPastedTextAttachment(text: string): Promise<void>
  addFileAttachment(filePath: string, file?: File): Promise<void>
  setTextAttachmentError(message: string): void
  setAttachmentBlockedNotice(value: boolean): void
}

/**
 * Composer paste handling: a copy of files made in this app's tree, then long
 * pastes (or drafts that would overflow the prompt cap) as text attachments,
 * then file items and clipboard images, in that order.
 */
export async function handleComposerPaste(
  e: ClipboardEvent,
  ctx: ComposerPasteContext
): Promise<void> {
  if (ctx.getReadOnlyMode() && !ctx.getAllowAttachments()) return
  const pastedText = e.clipboardData?.getData('text/plain') ?? ''
  const items = Array.from(e.clipboardData?.items ?? [])
  const pastedFiles = items
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)

  // A tree copy carries the real files and the `@tag` text that named them.
  // Inside the project those tags are what targets the file, so the paste stays
  // text and the composer's own mention handling takes over. Anywhere else the
  // tags name paths that do not exist here, so the files themselves are what
  // the user meant and the paste attaches them.
  const copy = ctx.getOwnFileCopy()
  if (copy && matchesProjectFileCopy(copy.paths, pastedText)) {
    if (copy.sameProject) return
    // The gesture belongs to the attachment path either way, so the tag text
    // must not reach the draft even when the files cannot be attached.
    e.preventDefault()
    if (ctx.getSelectedHarnessLacksAttachments()) {
      ctx.setAttachmentBlockedNotice(true)
      return
    }
    ctx.setTextAttachmentError('')
    const attached = await attachPastedFiles(pastedFiles, ctx)
    if (!attached) {
      ctx.setTextAttachmentError('The copied files could not be attached.')
    }
    return
  }

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
  if (ctx.getSelectedHarnessLacksAttachments()) {
    const hasFile = pastedFiles.length > 0 || items.some((item) => item.type.startsWith('image/'))
    if (hasFile) {
      e.preventDefault()
      ctx.setAttachmentBlockedNotice(true)
    }
    return
  }

  let hasFileAttachment = await attachPastedFiles(pastedFiles, ctx)

  if (!hasFileAttachment) {
    for (const item of items) {
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

/** Attach every pasted item that names a local file, answering whether any did. */
async function attachPastedFiles(
  files: readonly File[],
  ctx: ComposerPasteContext
): Promise<boolean> {
  let attached = false
  for (const file of files) {
    try {
      const filePath = await window.api.registerFileSelection(file, ctx.getAttachmentStorage())
      if (!filePath) continue
      await ctx.addFileAttachment(filePath, file)
      attached = true
    } catch {
      // Pasted item is not a local file; fall through to clipboard image handler.
    }
  }
  return attached
}
