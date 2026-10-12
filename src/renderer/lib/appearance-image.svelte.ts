import { invoke } from '$lib/ipc.svelte'
import { pickCustomIconImage } from './custom-icon-pipeline'

/**
 * A picked appearance image, ready both to preview and to persist.
 */
export interface PickedAppearanceImage {
  /** The app-owned copy's absolute path, which is what an appearance record keeps. */
  path: string
  /** The copy as a data URL, for the editor's preview before it is saved. */
  dataUrl: string
}

/**
 * Ask for an appearance image and return the app-owned copy of it.
 *
 * The pick goes through the shared custom-icon pipeline first, so what reaches
 * the main process is already a square, 64 px WebP rather than the file the user
 * chose. The OS dialog authorizes a path for this process only, so the path a
 * record persists cannot be the path the user picked: on the next launch the
 * stored path is outside every scope and the icon is refused. The main process
 * therefore writes the finished image into the app's own appearance directory
 * and this answers with that copy, which the editor previews and the record
 * keeps.
 *
 * Shared by every appearance editor (browser tab, group, box, bookmark and
 * sticky note) so none of them can drift back to keeping an unprepared file.
 * Returns null when the dialog was cancelled or the image could not be used.
 */
export async function pickAppearanceImage(): Promise<PickedAppearanceImage | null> {
  try {
    const picked = await pickCustomIconImage()
    if (!picked) return null
    return await invoke('appearance:storeImage', picked.image)
  } catch {
    // A refused or undecodable file leaves the entity on the icon it wears.
    return null
  }
}
