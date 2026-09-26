import { relative, sep } from 'node:path'
import { requireLocalProject } from '../../lib/project-artifacts'
import { resolveDesignDirectory } from '../design/design-paths'
import { saveDesignMedia } from '../design/design-media-service'
import { requiredString } from '../utilities/utility-orchestration/utility-input'
import { MAX_DESIGN_MEDIA_NAME_LENGTH } from '../../lib/design-media'
import {
  DESIGN_ASSIGNMENT_MEDIA_OUTPUTS,
  designAssignmentOutputWork,
  mediaModelForKind
} from '../../lib/design-assignments'
import {
  MEDIA_INPUT_JSON_MAX,
  MEDIA_INPUT_OPTION_MAX,
  MEDIA_PROMPT_MAX_LENGTH,
  isValidPromptField,
  mediaProviderLabel,
  parseMediaModelRef
} from '../../lib/media-generation'
import type { AppConfig } from '../../lib/types'
import type { DesignMediaKind } from '../../lib/design-media'
import type { DesignCapabilityExecutor } from '../utilities/utility-orchestration-service'
import type { Database } from '../database/database'
import type { MediaGenerationService } from './media-generation-service'

/**
 * Run the app-owned design capability's `generate` operation.
 *
 * This is the step the app was missing: an agent could ask a delegated model for
 * a music bed and get prose back, because the only lane a craft could staff was a
 * text completion. Here the prompt goes to the model the user assigned to that
 * craft, the provider answers with a URL, and the bytes are written into the
 * project by the same saver `save-media` uses, so there is one writer and one set
 * of byte ceilings for generated media.
 *
 * The operation never chooses a model. A craft with no user-assigned generation
 * model is refused by name, so the agent asks the user to pick one instead of
 * quietly reaching for a default.
 */

export interface MediaGenerationExecutorOptions {
  database: Database
  /** The live config, read per call so a settings change applies at once. */
  config: () => Promise<AppConfig>
  service: MediaGenerationService
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The media craft a call names, refused when it is not one of the three. */
function readKind(raw: unknown): DesignMediaKind {
  if (
    typeof raw !== 'string' ||
    !(DESIGN_ASSIGNMENT_MEDIA_OUTPUTS as readonly string[]).includes(raw)
  ) {
    throw new Error(
      `kind must be one of ${DESIGN_ASSIGNMENT_MEDIA_OUTPUTS.join(', ')}, and "${String(raw)}" is not`
    )
  }
  return raw as DesignMediaKind
}

/** The optional file name, refused when it carries a path. */
function optionalName(raw: unknown): string | undefined {
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

/** The provider input overrides, bounded so a hand-written call stays one request. */
function optionalOptions(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isRecord(raw)) throw new Error('options must be an object of provider input fields')
  if (Object.keys(raw).length > MEDIA_INPUT_OPTION_MAX) {
    throw new Error(`options accepts at most ${MEDIA_INPUT_OPTION_MAX} fields`)
  }
  if (JSON.stringify(raw).length > MEDIA_INPUT_JSON_MAX) throw new Error('options is too large')
  return raw
}

/** The optional input field the prompt is sent under, for a model that spells it differently. */
function optionalPromptField(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isValidPromptField(raw)) {
    throw new Error('prompt_field must be a short lowercase input name like "text"')
  }
  return raw
}

export function createMediaGenerationExecutor(
  options: MediaGenerationExecutorOptions
): DesignCapabilityExecutor {
  return async (operation, input, context) => {
    if (operation !== 'generate') {
      throw new Error(
        `The media generator exposes one operation, "generate", and no operation named "${operation}".`
      )
    }
    const kind = readKind(input['kind'])
    const prompt = requiredString(input['prompt'], 'prompt', MEDIA_PROMPT_MAX_LENGTH)
    const name = optionalName(input['name'])
    const providerOptions = optionalOptions(input['options'])
    const promptField = optionalPromptField(input['prompt_field'])

    const config = await options.config()
    const assigned = mediaModelForKind(config.design, kind)
    if (!assigned) {
      throw new Error(
        `The user has not put a model on ${designAssignmentOutputWork(kind)}. Ask them to assign one in Settings, Design, and name the craft as "${kind}". Never choose a generation model yourself.`
      )
    }
    const ref = parseMediaModelRef(assigned.model)
    if (!ref) {
      throw new Error(
        `The model assigned to ${designAssignmentOutputWork(kind)} is "${assigned.model}", which is not a model reference. Use "owner/name" or a version hash.`
      )
    }

    const project = requireLocalProject(options.database, context.projectId)
    const directory = resolveDesignDirectory(project.path, input['directory'])

    const result = await options.service.generate(kind, ref, assigned.model, {
      kind,
      prompt,
      ...(promptField ? { promptField } : {}),
      ...(name ? { name } : {}),
      ...(providerOptions ? { options: providerOptions } : {})
    })

    // The caller's name wins; otherwise the model names the file, because a
    // generated URL is an opaque identifier rather than something to read.
    const saved = await saveDesignMedia({
      directory: directory.absolute,
      source: result.url,
      name: name ?? assigned.model.replace(/[^a-z0-9]+/giu, '-')
    })
    const file = relative(project.path, saved.path).split(sep).join('/')
    const provider = mediaProviderLabel(result.providerId)
    return {
      file,
      directory: directory.display,
      reference: `./${saved.filename}`,
      kind: saved.kind,
      mime: saved.mime,
      bytes: saved.bytes,
      model: result.model,
      provider,
      note: `Generated the ${saved.kind} with ${result.model} on ${provider} and saved it into ${directory.display}. Reference it as "./${saved.filename}". Preview the folder to check it renders, and look at it before describing it.`
    }
  }
}
