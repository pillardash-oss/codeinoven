/**
 * The words the main process and the media server worker use with each other.
 *
 * A grant is the only way a file becomes reachable through the loopback server:
 * the main process has already resolved and authorized the path (a project
 * file, a thread workspace file, a stored attachment, an OS-opened file), and
 * the worker never learns any other path. The id in the URL is the grant, so a
 * URL from one file can never be edited into a URL for another.
 */

/** One file the loopback server may stream. */
export interface MediaServerGrant {
  /** Opaque id the URL carries; never derived from the path. */
  id: string
  /** Absolute path, known only to the worker and the main process. */
  path: string
  /** Extension with its dot, used for the content-disposition name. */
  extension: string
  mime: string
}

/** Main process to worker. */
export type MediaServerUpdate = { type: 'grant'; grant: MediaServerGrant } | { type: 'stop' }

/** Worker to main process. */
export type MediaServerEvent =
  | { type: 'ready'; port: number }
  /** One request was answered, which is what keeps the worker from idling out. */
  | { type: 'served' }
  /** Responses currently streaming, so the worker is never stopped mid-read. */
  | { type: 'busy'; active: number }
  | { type: 'failed'; message: string }
