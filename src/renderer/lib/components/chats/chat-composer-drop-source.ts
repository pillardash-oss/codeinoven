/**
 * What a drop actually carried.
 *
 * Chromium does not hand the destination renderer the files of a drag that
 * started in a page: dragging an image out of a browser page delivers the image's
 * URL as `text/uri-list` and its markup as `text/html`, with `dataTransfer.files`
 * empty and no `Files` entry in `types` at all. A composer that looked only at
 * `files` therefore saw an empty gesture. (Measured on Electron 44/macOS; the
 * probe that established it is described in `.cio/work/browser-drag-attach/plan.md`.)
 *
 * Reading the payload happens at drop time only. During `dragover` Chromium
 * answers an empty string for every `getData` call on a drag that came from
 * another document, so the drop overlay cannot be shown for a link it cannot yet
 * read; it can only be shown for the *shape* of the drag, which is what
 * `dropCarriesAttachable` does.
 */

/** Most links one drop is allowed to bring, so a hostile page cannot queue up
 *  unbounded fetches from a single gesture. */
const MAX_DROP_URLS = 8

/** Elements whose `src`/`href` names media a dragged selection can carry. */
const HTML_MEDIA_SELECTORS = ['img[src]', 'video[src]', 'audio[src]', 'source[src]', 'a[href]']

export interface ComposerDropPayload {
  /** Files the drag handed over as real `File` objects, in browser order. */
  files: File[]
  /** Media links the drag named instead of files. */
  urls: string[]
}

/**
 * The MIME type a dragged thread row writes.
 *
 * A thread dropped on the conversation is attached as context, not as a file, so
 * the drop has to be able to tell it apart from a drag that carried files or a
 * link before it reads anything else. The type is private to the app, which is
 * what keeps a foreign drag from claiming to be one of our threads.
 */
export const THREAD_DRAG_TYPE = 'application/x-cio-thread'

/** A thread a drag carried: its identity, and the name its badge reads. */
export interface DroppedThread {
  projectId: string
  threadId: string
  title: string
}

/** True when `types` carries an entry, whichever list shape it arrives in. */
function typesCarry(dataTransfer: DataTransfer, type: string): boolean {
  return Array.from(dataTransfer.types ?? []).includes(type)
}

/**
 * Whether this drag is worth showing the attach overlay for.
 *
 * Over-inclusive on purpose: a link drag carries `text/uri-list` too, and which
 * of the two it is cannot be read until the drop. Over-showing costs a warning
 * that says what could not be attached; under-showing is the silent no-op this
 * exists to remove.
 */
export function dropCarriesAttachable(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return (
    typesCarry(dataTransfer, 'Files') ||
    (dataTransfer.files?.length ?? 0) > 0 ||
    typesCarry(dataTransfer, 'text/uri-list') ||
    typesCarry(dataTransfer, THREAD_DRAG_TYPE)
  )
}

/** Whether this drag is a thread row being carried into the composer. */
export function dropCarriesThread(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  return typesCarry(dataTransfer, THREAD_DRAG_TYPE)
}

/**
 * The thread a drag carried, or null when it carried none.
 *
 * Read at drop time only: during `dragover` a drag from another document answers
 * empty for every `getData`, so the overlay is raised from the type alone.
 */
export function droppedThread(dataTransfer: DataTransfer | null): DroppedThread | null {
  if (!dataTransfer) return null
  let raw: string
  try {
    raw = dataTransfer.getData(THREAD_DRAG_TYPE) ?? ''
  } catch {
    return null
  }
  if (raw.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const projectId = record.projectId
  const threadId = record.threadId
  if (typeof projectId !== 'string' || typeof threadId !== 'string') return null
  if (projectId.length === 0 || threadId.length === 0) return null
  const title = typeof record.title === 'string' ? record.title.trim() : ''
  return { projectId, threadId, title: title.length > 0 ? title : 'Thread' }
}

/** One `text/uri-list` body split into its URIs. The format is one URI per line,
 *  a `#` starts a comment, and a comma is accepted as a separator because some
 *  sources write it that way. */
function urisFromList(raw: string): string[] {
  return raw
    .split(/[\r\n,]+/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/**
 * Absolute URLs named by the drag's markup, for a drag that carried no list.
 *
 * A relative reference is skipped rather than resolved: this document is not the
 * document the markup came from, so resolving it here would name the wrong file.
 */
function urlsFromHtml(raw: string): string[] {
  if (raw.trim().length === 0) return []
  const document = new DOMParser().parseFromString(raw, 'text/html')
  const found: string[] = []
  for (const selector of HTML_MEDIA_SELECTORS) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      const value =
        element.getAttribute('src') ?? element.getAttribute('href') ?? element.textContent ?? ''
      const trimmed = value.trim()
      if (trimmed.length === 0 || found.includes(trimmed)) continue
      found.push(trimmed)
    }
  }
  return found.filter((value) => isAbsoluteWebUrl(value))
}

/** Whether a string is an absolute http/https URL. */
function isAbsoluteWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The links a drop named, in the order they should be attached, deduplicated.
 *
 * `text/uri-list` is the authority: Chromium fills it with the media's own
 * absolute URL for an image, video or audio drag. The markup is read only when
 * a drag carried no list, and the plain-text reading only when neither named an
 * absolute web URL.
 */
export function dropMediaUrls(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return []
  const read = (type: string): string => {
    try {
      return dataTransfer.getData(type) ?? ''
    } catch {
      return ''
    }
  }

  const candidates = [...urisFromList(read('text/uri-list')), ...urlsFromHtml(read('text/html'))]
  const plain = read('text/plain').trim()
  if (plain.length > 0) candidates.push(plain)

  const urls: string[] = []
  for (const candidate of candidates) {
    if (!isAbsoluteWebUrl(candidate)) continue
    if (urls.includes(candidate)) continue
    urls.push(candidate)
    if (urls.length >= MAX_DROP_URLS) break
  }
  return urls
}

/** Read everything one drop carried: the files it handed over and the links it
 *  named instead. */
export function readComposerDrop(dataTransfer: DataTransfer | null): ComposerDropPayload {
  if (!dataTransfer) return { files: [], urls: [] }
  return {
    files: Array.from(dataTransfer.files ?? []),
    urls: dropMediaUrls(dataTransfer)
  }
}
