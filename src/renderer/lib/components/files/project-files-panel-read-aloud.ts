import type { SpeechScope } from '$shared/speech/types'

/**
 * The open document as a read-aloud target, or null when the viewer cannot hand
 * this file to the speech model (it is not a rendered document, or the conflict
 * editor owns the body).
 */
export interface DocumentReadAloud {
  /** Speech identity of the document this playback speaks. */
  messageId: string
  /** The document's text as the viewer holds it, unsaved edits included. */
  markdown: string
  /** Where the spoken document belongs, so the thread's audio indicator can
   *  report it like any other speech action in that conversation. */
  scope: SpeechScope
  /** True while the body has no text to speak yet (the file is still loading,
   *  or it is empty). */
  disabled: boolean
}

/**
 * Identity of one document's read-aloud.
 *
 * The main process validates a playback id as `[a-zA-Z0-9._:-]{3,128}`, which a
 * project-relative path is not (slashes, spaces, unbounded length), so the id
 * is a stable hash of the document's location instead. Hashing the location and
 * not the text is deliberate: one document keeps one read-aloud identity in
 * every pane that shows it and across its working copy and checkpoint views, so
 * the pause control and the read-along follow the file rather than the tab.
 */
export function documentReadAloudId(projectId: string, path: string): string {
  return `file-${fnv1aHex(`${projectId}\n${path}`)}`
}

/** Whether the viewer has any text worth speaking: whitespace alone reads as
 *  silence, so the control stays refused until a real body is on screen. */
export function hasSpeakableText(content: string): boolean {
  return content.trim().length > 0
}

/** FNV-1a, 32-bit, hex. A read-aloud id is a correlation token for one live
 *  playback session, never a persisted key, so a short stable hash is enough
 *  and keeps the id inside the shape the main process accepts. */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    // 32-bit FNV prime (16777619); `Math.imul` keeps the product in int32.
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
