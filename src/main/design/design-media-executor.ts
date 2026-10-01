import { relative, sep } from 'node:path'
import { requireLocalProject } from '../../lib/project-artifacts'
import {
  MAX_DESIGN_MEDIA_NAME_LENGTH,
  MAX_DESIGN_MEDIA_SOURCE_LENGTH
} from '../../lib/design-media'
import { requiredString } from '../utilities/utility-orchestration/utility-input'
import { resolveServedFolder } from '../preview/served-folder'
import { currentWorkRoot } from './work-roots-state'
import { saveDesignMedia } from './design-media-service'
import type { Database } from '../database/database'
import type { DesignCapabilityExecutor } from '../utilities/utility-orchestration-service'

/**
 * Run the app-owned design capability's `save-media` operation.
 *
 * A generation service answers with a link, and that link usually expires, so a
 * design cannot reference it and stay working. This is the one step that turns
 * the link into a file beside the design, which is what lets the markup carry a
 * plain relative reference like `./hero.mp4` and keep rendering after the
 * service has forgotten the asset.
 *
 * The operation is deliberately media-only: the type has to come from the
 * response or the URL, so it cannot be used as a general-purpose downloader.
 */

/** What the app needs from the design capability here: the project, to resolve it. */
export interface DesignMediaExecutorOptions {
  database: Database
}

/**
 * An optional file name for the saved asset.
 *
 * A caller that omits it lets the source URL name the file. A caller that writes
 * a path rather than a name is refused rather than trimmed, because silently
 * writing somewhere other than the folder it asked about is worse than failing.
 */
function optionalMediaName(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error('name must be a string')
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > MAX_DESIGN_MEDIA_NAME_LENGTH) throw new Error('name is too long')
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('name must be a file name without a path, since the folder names the folder')
  }
  return trimmed
}

export function createDesignMediaExecutor(
  options: DesignMediaExecutorOptions
): DesignCapabilityExecutor {
  return async (operation, input, context) => {
    if (operation !== 'save-media') {
      throw new Error(
        `The design media saver exposes one operation, "save-media", and no operation named "${operation}".`
      )
    }
    const source = requiredString(input['source'], 'source', MAX_DESIGN_MEDIA_SOURCE_LENGTH)
    const name = optionalMediaName(input['name'])
    const project = requireLocalProject(options.database, context.projectId)
    const directory = resolveServedFolder(
      project.path,
      input['directory'],
      currentWorkRoot('design')
    )

    const saved = await saveDesignMedia({
      directory: directory.absolute,
      source,
      name
    })
    const file = relative(project.path, saved.path).split(sep).join('/')
    return {
      file,
      directory: directory.display,
      reference: `./${saved.filename}`,
      kind: saved.kind,
      mime: saved.mime,
      bytes: saved.bytes,
      note: `Saved the ${saved.kind} into ${directory.display}. Reference it from the design's entry file as "./${saved.filename}", then preview the folder to check it renders.`
    }
  }
}
