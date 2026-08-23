import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, opendir, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { platform } from 'node:os'
import type { BrainstormPrototype, BrainstormPrototypeFidelity } from '../types'

export const PROTOTYPE_ASSET_BYTE_LIMIT = 25 * 1024 * 1024
export const PROTOTYPE_SESSION_BYTE_LIMIT = 100 * 1024 * 1024
export const PROTOTYPE_GENERATION_BATCH_SIZE = 2

export interface PrototypeGenerationPlanItem {
  id: string
  fidelity: BrainstormPrototypeFidelity
}

export function planPrototypeGeneration(
  fidelity: BrainstormPrototypeFidelity,
  requestedCount?: number
): PrototypeGenerationPlanItem[][] {
  const defaultCount = fidelity === 'lofi' ? 2 : 1
  const count = requestedCount ?? defaultCount
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
    throw new RangeError('Prototype count must be between 1 and 20')
  }
  const prefix = fidelity === 'lofi' ? 'L' : 'H'
  const items = Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index + 1}`,
    fidelity
  }))
  return Array.from(
    { length: Math.ceil(items.length / PROTOTYPE_GENERATION_BATCH_SIZE) },
    (_, index) =>
      items.slice(
        index * PROTOTYPE_GENERATION_BATCH_SIZE,
        (index + 1) * PROTOTYPE_GENERATION_BATCH_SIZE
      )
  )
}

const SAFE_FEATURE = /^[a-z0-9][a-z0-9-]{0,127}$/u
const SAFE_PROTOTYPE_ID = /^[LH][1-9][0-9]*$/u

export interface PrototypeArtifactInput {
  projectRoot: string
  featureSlug: string
  prototypeId: string
  fidelity: BrainstormPrototypeFidelity
  title: string
  entryFile: string
  parentPrototypeId?: string
  createdAt?: number
}

export interface PrototypeArtifactPaths {
  canonicalRoot: string
  previewRoot: string
  previewSlug: string
  artifactPath: string
  previewPath: string
}

function assertInside(root: string, target: string, label: string): void {
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError(`${label} escapes its approved root`)
  }
}

function validateSegment(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new TypeError(`Invalid ${label}`)
}

export function resolvePrototypeArtifactPaths(
  projectRoot: string,
  featureSlug: string,
  prototypeId: string
): PrototypeArtifactPaths {
  if (!isAbsolute(projectRoot)) throw new TypeError('Project root must be absolute')
  validateSegment(featureSlug, SAFE_FEATURE, 'feature slug')
  validateSegment(prototypeId, SAFE_PROTOTYPE_ID, 'prototype identifier')
  const normalizedId = prototypeId.toLowerCase()
  const canonicalRoot = resolve(
    projectRoot,
    '.cio',
    'specs',
    featureSlug,
    'prototypes',
    prototypeId
  )
  const previewSlug = `${featureSlug}-${normalizedId}`
  const previewRoot = resolve(projectRoot, 'cio', previewSlug)
  assertInside(
    resolve(projectRoot, '.cio', 'specs', featureSlug, 'prototypes'),
    canonicalRoot,
    'Artifact'
  )
  assertInside(resolve(projectRoot, 'cio'), previewRoot, 'Preview')
  return {
    canonicalRoot,
    previewRoot,
    previewSlug,
    artifactPath: `.cio/specs/${featureSlug}/prototypes/${prototypeId}`,
    previewPath: `cio/${previewSlug}/`
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { highWaterMark: 256 * 1024 })
    stream.on('data', (chunk: Buffer) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolvePromise)
  })
  return hash.digest('hex')
}

async function inspectTree(root: string): Promise<{ bytes: number; hashes: string[] }> {
  let bytes = 0
  const hashes: string[] = []
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()
    if (!directory) break
    const handle = await opendir(directory)
    for await (const entry of handle) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new TypeError('Prototype assets cannot contain symlinks')
      if (info.isDirectory()) {
        queue.push(path)
        continue
      }
      if (!info.isFile()) continue
      if (info.size > PROTOTYPE_ASSET_BYTE_LIMIT) {
        throw new RangeError(`Prototype asset exceeds ${PROTOTYPE_ASSET_BYTE_LIMIT} bytes`)
      }
      bytes += info.size
      if (bytes > PROTOTYPE_SESSION_BYTE_LIMIT) {
        throw new RangeError(`Prototype session exceeds ${PROTOTYPE_SESSION_BYTE_LIMIT} bytes`)
      }
      hashes.push(await hashFile(path))
    }
  }
  return { bytes, hashes: hashes.sort() }
}

async function ensurePreviewLink(paths: PrototypeArtifactPaths): Promise<void> {
  await mkdir(dirname(paths.previewRoot), { recursive: true })
  try {
    await lstat(paths.previewRoot)
    throw new Error(`Prototype preview path already exists: ${paths.previewPath}`)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  await symlink(paths.canonicalRoot, paths.previewRoot, platform() === 'win32' ? 'junction' : 'dir')
  const linked = await realpath(paths.previewRoot)
  const canonical = await realpath(paths.canonicalRoot)
  if (linked !== canonical)
    throw new Error('Prototype preview link resolves to an unexpected target')
}

export async function finalizePrototypeArtifact(
  input: PrototypeArtifactInput
): Promise<BrainstormPrototype> {
  const paths = resolvePrototypeArtifactPaths(
    input.projectRoot,
    input.featureSlug,
    input.prototypeId
  )
  const canonical = await realpath(paths.canonicalRoot)
  const approvedRoot = await realpath(
    resolve(input.projectRoot, '.cio', 'specs', input.featureSlug, 'prototypes')
  )
  assertInside(approvedRoot, canonical, 'Artifact')
  const entry = resolve(canonical, input.entryFile)
  assertInside(canonical, entry, 'Prototype entry file')
  const entryInfo = await stat(entry)
  if (!entryInfo.isFile()) throw new TypeError('Prototype entry file must be a regular file')
  const inspection = await inspectTree(canonical)
  const contentHash = createHash('sha256')
    .update(JSON.stringify({ bytes: inspection.bytes, hashes: inspection.hashes }))
    .digest('hex')
  const prototype: BrainstormPrototype = {
    id: input.prototypeId,
    fidelity: input.fidelity,
    title: input.title.trim(),
    ...(input.parentPrototypeId ? { parentPrototypeId: input.parentPrototypeId } : {}),
    entryFile: input.entryFile,
    artifactPath: paths.artifactPath,
    previewPath: paths.previewPath,
    contentHash,
    createdAt: input.createdAt ?? Date.now()
  }
  if (!prototype.title) throw new TypeError('Prototype title is required')
  const manifestPath = join(canonical, 'prototype.json')
  const temporaryManifest = `${manifestPath}.${process.pid}.tmp`
  await writeFile(temporaryManifest, `${JSON.stringify(prototype, null, 2)}\n`, { flag: 'wx' })
  await rename(temporaryManifest, manifestPath)
  await ensurePreviewLink(paths)
  return prototype
}
