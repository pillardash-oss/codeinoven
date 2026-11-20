import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { OvenProbe, OvenWorkspaceRequest, OvenWorkspaceResult } from '../../lib/ovens'
import { ovenDataRoot, ovenDirKey } from './remote/oven-root-paths'

/**
 * The app's own Pi extensions have to exist on the machine Pi runs on.
 *
 * A local spawn hands Pi `--extension <absolute local path>`, so a remote Oven
 * thread used to start Pi with the app's tool layer missing: no core tools, no
 * compaction policy, and none of the custom providers the model picker offered.
 * This module publishes the same module sources the local spawn uses into the
 * Oven's app data directory and returns the argv the Oven-side spawn needs.
 *
 * Nothing here generates extension source: the local materialization already
 * wrote it (and, for the core tools, embeds the per-session handoff paths it was
 * built with), so the caller reads those files and publishes their text.
 */

/** One app-owned extension, under the file name the local spawn gives it. */
export interface OvenPiExtensionFile {
  name: string
  content: string
}

/** The extension sources a local Pi spawn passes through `--extension`. */
export interface OvenPiExtensionFiles {
  coreTools: OvenPiExtensionFile
  providers?: OvenPiExtensionFile
}

/** The slice of the Oven client publishing extensions needs. */
export interface OvenPiExtensionService {
  workspace(id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult>
  probe(id: string): Promise<OvenProbe>
}

/** The local files the materialization step left behind, in memory already. */
export interface PiExtensionSourcePaths {
  /** Absolute path of the materialized `cio-core-tools.ts` module. */
  coreToolsPath: string
  /** Absolute path of the materialized providers module, when pi wrote one. */
  providersPath?: string | null
}

/** One write the Oven's file API accepts, in its 128 KiB chunks. */
const CHUNK_BYTES = 128 * 1024

/** Extension modules are read by the harness process only; never world-readable. */
const FILE_MODE = 0o600

/** A published module's content digest lives beside it under this suffix. */
const HASH_SUFFIX = '.sha256'

/**
 * A file name this module is willing to place on an Oven.
 *
 * The name comes from a local materialization, but it still crosses into a path
 * a remote machine resolves, so a separator, a drive letter, or a relative
 * segment is refused here instead of being turned into a traversal.
 */
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u

/** A home directory an Oven reports: POSIX absolute, or a Windows drive path. */
const ABSOLUTE_HOME = /^(?:\/|[A-Za-z]:[\\/])/u

/** One extension described once, for the publish loop and for its errors. */
interface PiExtensionPlan extends OvenPiExtensionFile {
  /** Human label an error can name without exposing the module source. */
  label: string
}

/**
 * The Oven directory every app-owned Pi extension is published into.
 *
 * One directory for the whole Oven, so a cleanup can find them all, and it sits
 * inside the app data root rather than in a checkout: an extension is app state,
 * never part of the user's repository.
 */
export function ovenPiExtensionsRoot(home: string): string {
  return `${ovenDataRoot(home)}/pi-extensions`
}

/**
 * The directory one session's extensions are published into.
 *
 * The core-tools module embeds the session's own handoff paths, so its content is
 * session-scoped and two sessions can never share one file. The directory name is
 * derived through the same hash the Oven's scope checkouts use, so an id with any
 * character in it still resolves to a safe, collision-resistant segment.
 */
export function ovenPiSessionExtensionsRoot(home: string, sessionId: string): string {
  return `${ovenPiExtensionsRoot(home)}/${ovenDirKey(sessionId)}`
}

/**
 * Read the extension files a local Pi spawn would pass as `--extension`.
 *
 * The core-tools module is generated per session (it embeds the handoff file
 * paths it reads at runtime) and the providers module is generated per process
 * boot, so neither source is a constant this module could rebuild. Both are read
 * from the files the local materialization wrote, under the names it gave them.
 */
export async function readPiExtensionFiles(
  input: PiExtensionSourcePaths
): Promise<OvenPiExtensionFiles> {
  const coreTools = await readExtensionFile(input.coreToolsPath, 'cio-core-tools')
  const providers = input.providersPath
    ? await readExtensionFile(input.providersPath, 'cio-providers')
    : undefined
  return { coreTools, ...(providers ? { providers } : {}) }
}

/**
 * Publish the app's Pi extensions on one Oven and return the spawn argv.
 *
 * Content is written through a staging file and renamed into place, so Pi can
 * never load a half-written module, and the digest beside each module means a
 * second turn with unchanged content costs one read instead of a write. Every
 * failure is thrown: starting Pi on an Oven without the app's own tools would
 * silently restore pi's default compaction policy and hide the app's tools.
 */
export async function publishOvenPiExtensions(input: {
  service: OvenPiExtensionService
  ovenId: string
  sessionId: string
  /** Reads the same sources the local spawn uses. */
  files: OvenPiExtensionFiles
}): Promise<{ extensionArgs: string[] }> {
  const plans = extensionPlans(input.files)
  const probe = await input.service.probe(input.ovenId).catch((error: unknown) => {
    throw new Error(
      `The Oven did not answer, so the Pi extensions cannot be published there: ${messageOf(error)}`,
      { cause: error }
    )
  })
  if (!ABSOLUTE_HOME.test(probe.home))
    throw new Error(
      'The Oven did not report a home directory, so the Pi extensions cannot be published there.'
    )
  const root = ovenPiSessionExtensionsRoot(probe.home, input.sessionId)
  await extensionStep(`the Pi extension directory ${root}`, () =>
    input.service.workspace(input.ovenId, { operation: 'ensure', root })
  )
  const extensionArgs: string[] = []
  for (const plan of plans) {
    await publishExtensionFile(input.service, input.ovenId, root, plan)
    extensionArgs.push('--extension', `${root}/${plan.name}`)
  }
  return { extensionArgs }
}

/** The extensions in the order a spawn passes them, refusing an unsafe name. */
function extensionPlans(files: OvenPiExtensionFiles): PiExtensionPlan[] {
  const plans: PiExtensionPlan[] = [{ ...files.coreTools, label: 'cio-core-tools' }]
  if (files.providers) plans.push({ ...files.providers, label: 'cio-providers' })
  for (const plan of plans) {
    if (!FILE_NAME.test(plan.name) || plan.name === '..' || plan.name === '.')
      throw new Error(
        `Refusing to publish the Pi ${plan.label} extension under the unsafe file name "${plan.name}".`
      )
  }
  if (plans.length === 2 && plans[0]?.name === plans[1]?.name)
    throw new Error(
      `The Pi ${plans[0]?.label} and ${plans[1]?.label} extensions cannot share the file name "${plans[0]?.name}".`
    )
  return plans
}

/**
 * Publish one module, rewriting it only when its content differs from the copy
 * already on the Oven.
 *
 * The comparison is the digest written beside the module plus its size, so a
 * module deleted or truncated behind this app's back is still republished.
 */
async function publishExtensionFile(
  service: OvenPiExtensionService,
  ovenId: string,
  root: string,
  plan: PiExtensionPlan
): Promise<void> {
  const bytes = Buffer.from(plan.content, 'utf8')
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (await isPublished(service, ovenId, root, plan, digest, bytes.length)) return
  await stageAndPublish(service, ovenId, root, plan, plan.name, bytes)
  await stageAndPublish(
    service,
    ovenId,
    root,
    plan,
    `${plan.name}${HASH_SUFFIX}`,
    Buffer.from(digest, 'utf8')
  )
}

/**
 * Write one file beside its destination and rename it into place.
 *
 * A rename is the only step pi can observe, so a channel that drops mid-write
 * leaves the previous module intact instead of a truncated one, and the rename
 * replaces whatever the destination held (a shorter digest included).
 */
async function stageAndPublish(
  service: OvenPiExtensionService,
  ovenId: string,
  root: string,
  plan: PiExtensionPlan,
  path: string,
  bytes: Buffer
): Promise<void> {
  const staged = `${path}.${randomUUID()}.next`
  for (let offset = 0; offset < bytes.length || offset === 0; offset += CHUNK_BYTES) {
    await extensionStep(`the Pi ${plan.label} extension (${path})`, () =>
      service.workspace(ovenId, {
        operation: 'write',
        root,
        path: staged,
        offset,
        data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64'),
        exclusive: offset === 0,
        mode: FILE_MODE
      })
    )
  }
  await extensionStep(`the Pi ${plan.label} extension (${path})`, () =>
    service.workspace(ovenId, { operation: 'replace', root, path, staged, mode: FILE_MODE })
  )
}

/** Whether the module already on the Oven is this exact content. */
async function isPublished(
  service: OvenPiExtensionService,
  ovenId: string,
  root: string,
  plan: PiExtensionPlan,
  digest: string,
  size: number
): Promise<boolean> {
  const published = await readText(service, ovenId, root, `${plan.name}${HASH_SUFFIX}`)
  if (published !== digest) return false
  try {
    const result = await service.workspace(ovenId, {
      operation: 'stat',
      root,
      path: plan.name
    })
    return result.file?.kind === 'file' && result.file.size === size
  } catch {
    // A digest with no module beside it is a leftover of an interrupted publish.
    return false
  }
}

/** A small published file's text, or null when it is not there. */
async function readText(
  service: OvenPiExtensionService,
  ovenId: string,
  root: string,
  path: string
): Promise<string | null> {
  try {
    const result = await service.workspace(ovenId, { operation: 'read', root, path, offset: 0 })
    return Buffer.from(result.data ?? '', 'base64').toString('utf8')
  } catch {
    return null
  }
}

/** Run one publish step, turning its failure into an error a caller can surface. */
async function extensionStep<T>(subject: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(
      `Could not publish ${subject} to the Oven: ${messageOf(error)}. Pi cannot start on this Oven without the app's own tools.`,
      { cause: error }
    )
  }
}

/** One materialized extension module, read back as the text a spawn would load. */
async function readExtensionFile(path: string, label: string): Promise<OvenPiExtensionFile> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(
      `Cannot read the materialized Pi ${label} extension at ${path}: ${messageOf(error)}`,
      { cause: error }
    )
  }
  if (!content.trim())
    throw new Error(`The materialized Pi ${label} extension at ${path} is empty.`)
  return { name: basename(path), content }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
