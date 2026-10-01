import { checkAttachableMediaUrl } from '../../lib/attachable-media-url'
import {
  saveRemoteMedia,
  type RemoteMediaPolicy,
  type SavedRemoteMedia
} from '../util/remote-media-transfer'

/**
 * Turn a media link the user dragged out of a page into a real attachment file.
 *
 * A drag out of a web page carries no file: Chromium hands the destination the
 * link (and the markup) and nothing else, so a composer that only understands
 * dropped files sees an empty gesture. The bytes have to be fetched, and the
 * renderer cannot do it (a cross-origin image read through `fetch` answers with
 * an opaque body), so the fetch happens here and lands as a file the existing
 * attachment pipeline can then preview, send and clean up like any other.
 */

/**
 * Ceiling for one fetched media attachment, matching the ceiling a pathless
 * dropped file is held to, so the same picture is accepted whether the page
 * handed it over as a file or as a link.
 */
export const MAX_REMOTE_ATTACHMENT_BYTES = 32 * 1024 * 1024

/**
 * The composer's policy. It differs from the design studio's in exactly two
 * ways, both deliberate: a link from the app's own browser is allowed to be a
 * `http` link to a local host (that is what the browser is used for), and every
 * media kind shares one ceiling because the user is attaching a picture, not
 * publishing an asset.
 */
const ATTACHMENT_MEDIA_POLICY: RemoteMediaPolicy = {
  checkSource: checkAttachableMediaUrl,
  maxBytes: () => MAX_REMOTE_ATTACHMENT_BYTES,
  overLimitError: (_type, maxBytes) =>
    new Error(
      `That file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit for an attachment.`
    ),
  notWritableError: (destination, cause) =>
    new Error(`The attachment folder is not writable: ${destination}`, { cause })
}

export interface RetainRemoteMediaRequest {
  /** The link the drag carried. */
  source: string
  /** Absolute attachment folder for the scope the composer belongs to. */
  directory: string
}

/** Fetch one dragged media link into `directory` and report the file written. */
export async function retainRemoteMediaAttachment(
  request: RetainRemoteMediaRequest
): Promise<SavedRemoteMedia> {
  return saveRemoteMedia({ ...request, policy: ATTACHMENT_MEDIA_POLICY })
}
