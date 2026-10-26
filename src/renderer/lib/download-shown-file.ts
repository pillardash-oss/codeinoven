import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'

/**
 * Save one file the app is showing, to the place the user chooses.
 *
 * A preview is drawn from one of two sources, and they need different routes to
 * the disk:
 *
 * - An inline artifact is served from `appfile://`, and the bytes behind it live
 *   in a workspace the app is free to clean up. The renderer's download guard
 *   allows nothing but the window's own `blob:` URLs, so the browser's own
 *   download of that URL is refused and the control did nothing at all, with no
 *   dialog and no file. The copy is therefore taken in the main process
 *   (`dialog:saveCopy`), which owns the served path, the save dialog and the
 *   write.
 * - Anything else the preview holds is already a `blob:` URL. Chromium's own
 *   download assistant is right for those bytes, and the name registered against
 *   the URL is what its save dialog suggests instead of a bare UUID.
 *
 * Every surface that offers "download" calls this one function, so "which of the
 * two routes applies" is answered once.
 */
export function downloadShownFile(url: string, filename: string): void {
  if (url.startsWith('appfile://')) {
    void copyServedFile(url, filename)
    return
  }
  if (url.startsWith('blob:')) {
    void invoke('download:nameLocalBlob', url, filename).catch(() => undefined)
  }
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.append(link)
  link.click()
  link.remove()
}

/** Copy a served file out of the workspace it lives in, and confirm it. */
async function copyServedFile(url: string, filename: string): Promise<void> {
  try {
    const saved = await invoke('dialog:saveCopy', { url, suggestedName: filename })
    if (saved !== null) toast.success(`Saved ${filename}`)
  } catch {
    toast.error(`Could not save ${filename}`)
  }
}
