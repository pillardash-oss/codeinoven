import { checkDesignMediaSource, type DesignMediaKind } from '../../lib/design-media'
import { saveRemoteMedia, type RemoteMediaPolicy } from '../util/remote-media-transfer'

/**
 * Bring generated media into a project folder as a real file.
 *
 * A generation service answers with a URL, and those URLs are usually
 * short-lived signed links, so a design that references one is broken as soon as
 * the link expires. This service is what turns such a source into a file beside
 * the design's entry file, so the markup references `./hero.mp4` and keeps
 * working after the link is gone.
 *
 * The source is a link a model wrote, so it is treated as untrusted input: HTTPS
 * only, never a host on this machine or the local network, every redirect hop
 * re-checked, a hard byte ceiling and a deadline per hop, and nothing is kept
 * unless the whole transfer completes. That transfer is
 * `src/main/util/remote-media-transfer.ts`; what this module adds is the design
 * studio's own answer to which sources count, how large each kind may get, and
 * how a refusal is worded for the model that asked.
 */

export interface SaveDesignMediaRequest {
  /** Absolute folder the file lands in. The caller owns path validation. */
  directory: string
  /** The https link a generation service answered with. */
  source: string
  /** File name without an extension. Taken from the source when absent. */
  name?: string | undefined
}

export interface SavedDesignMedia {
  filename: string
  /** Absolute path of the written file. */
  path: string
  kind: DesignMediaKind
  mime: string
  bytes: number
  /** The URL that actually served the bytes, after any redirect. */
  source: string
}

/** The design studio's policy for a remote media source. */
const DESIGN_MEDIA_POLICY: RemoteMediaPolicy = {
  checkSource: checkDesignMediaSource,
  maxBytes: (type) => type.maxBytes,
  overLimitError: (type, maxBytes) =>
    new Error(
      `The source is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB ceiling for ${type.kind} files.`
    ),
  notWritableError: (destination, cause) =>
    new Error(`The design folder is not writable: ${destination}`, { cause })
}

/**
 * Save one generated asset into a folder and report what was written.
 *
 * Nothing lands under the final name unless the whole transfer succeeded: the
 * bytes go to `<name>.<extension>.part` and are renamed, so a design folder never
 * gains a truncated video that looks like a complete one.
 */
export async function saveDesignMedia(request: SaveDesignMediaRequest): Promise<SavedDesignMedia> {
  return saveRemoteMedia({ ...request, policy: DESIGN_MEDIA_POLICY })
}
