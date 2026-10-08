import { invoke } from '$lib/ipc.svelte'

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
 * The OS dialog authorizes a path for this process only, so the path a record
 * persists cannot be the path the user picked: on the next launch the stored
 * path is outside every scope and the icon is refused. The main process
 * therefore copies the picked file into the app's own appearance directory and
 * this answers with that copy, which the editor previews and the record keeps.
 *
 * Shared by every appearance editor (browser tab, group, box, bookmark and
 * sticky note) so none of them can drift back to keeping the picked path.
 * Returns null when the dialog was cancelled or the copy failed.
 */
export async function pickAppearanceImage(): Promise<PickedAppearanceImage | null> {
  const picked = await invoke('dialog:pickImage')
  if (!picked) return null
  try {
    return await invoke('appearance:storeImage', picked)
  } catch {
    // A refused or unsupported file leaves the entity on the icon it wears.
    return null
  }
}
