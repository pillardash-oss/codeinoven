import { GLOBAL_BROWSER_PROJECT_ID } from '../../lib/ipc/browser'
import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { toPosixPath } from '../../lib/paths'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ASSISTANT_SPACE_ID,
  INBOX_PROJECT_ID,
  type AgentArtifact,
  type AgentMessage,
  type AgentPart,
  type Thread
} from '../../lib/types'
import {
  LEGACY_CHAT_ARTIFACTS_DIRECTORY,
  LEGACY_CHATS_ARTIFACTS_DIRECTORY,
  assistantThreadWorkspaceDirectory,
  chatThreadWorkspaceDirectory,
  browserThreadWorkspaceDirectory,
  featureSlugFromTitle,
  PROJECT_DATA_DIRECTORY
} from '../../lib/project-artifacts'
import { ensureDir } from '../../lib/utils'
import type { StorageEngine } from '../storage/storage-engine'

const IMAGE_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.tif',
  '.tiff',
  '.webp'
])
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp'
}
const MAX_SCAN_FILES = 4_000
const MAX_SCAN_DEPTH = 8
const SKIPPED_DIRECTORIES = new Set([
  '.cio',
  '.git',
  '.svelte-kit',
  'build',
  'dist',
  'node_modules',
  'out'
])
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\(([^)\s]+)\)/gu
const IMAGE_EXTENSION_PATTERN = 'avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp'
/** A reference the writer meant as an image: a data or file URL, an absolute
 *  path, or a path naming the image through its own filename. */
const IMAGE_REFERENCE_PATTERN = new RegExp(
  `(?:data:image\\/[a-z0-9.+-]+;[^\\s<>'")]+|file:\\/\\/[^\\s<>'")]+|(?:[A-Za-z]:[\\\\/]|\\/|\\.\\.?[\\\\/])[^\\s<>'")]+\\.(?:${IMAGE_EXTENSION_PATTERN})(?:[?#][^\\s<>'")]*)?|[\\w.-]+(?:[\\\\/][\\w.-]+)+\\.(?:${IMAGE_EXTENSION_PATTERN})|[\\w.-]+\\.(?:${IMAGE_EXTENSION_PATTERN}))`,
  'giu'
)
/** The subset a command's own output can only mean literally: a data or file
 *  URL, an absolute path, or an explicitly cwd-relative path. A bare or
 *  project-relative filename in shell output is a listing entry (`git status`,
 *  `ls`, `rg --files`), never an image the tool produced. */
const PRODUCED_IMAGE_REFERENCE_PATTERN = new RegExp(
  `(?:data:image\\/[a-z0-9.+-]+;[^\\s<>'")]+|file:\\/\\/[^\\s<>'")]+|(?:[A-Za-z]:[\\\\/]|\\/|\\.\\.?[\\\\/])[^\\s<>'")]+\\.(?:${IMAGE_EXTENSION_PATTERN})(?:[?#][^\\s<>'")]*)?)`,
  'giu'
)

interface ArtifactContext {
  scope: 'chat' | 'project'
  /** Root of the conversation's own file surface: a chat's `chats-cwd/<threadId>`
   *  workspace directory, or the project directory. */
  projectPath: string
  sourceRoot: string
  artifactRoot: string
  /** Roots that chats started before the per-thread workspace consolidation
   *  wrote images to. A file already inside one of them stays in-root for the
   *  thread that owns it instead of being copied. */
  legacyArtifactRoots: string[]
}

interface ImageCandidate {
  source: string
  mime?: string
  filename?: string
}

interface MaterializedImage {
  path: string
  url: string
  mime: string
  filename: string
  identity: string
}

interface SynchronizationResult {
  messages: AgentMessage[]
  changed: boolean
}

interface ScannedImage {
  path: string
  modifiedAt: number
}

/** Resolve a reference against the surface it was written on, the same way
 *  `materialize` does, so a part and its reference compare by one path. */
function referencePath(source: string, context: ArtifactContext): string | null {
  if (source.startsWith('data:')) return null
  const rawPath = filePathFromUrl(source)
  if (!rawPath) return null
  return isAbsolute(rawPath) ? resolve(rawPath) : resolve(context.sourceRoot, rawPath)
}

type ProjectArtifactThread = Pick<Thread, 'id' | 'title' | 'featureSlug'>

function isImagePath(value: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(value.split(/[?#]/u)[0] ?? '').toLowerCase())
}

function mimeForPath(path: string): string {
  return IMAGE_MIME_TYPES[extname(path).toLowerCase()] ?? 'image/png'
}

function trimReference(value: string): string {
  return value.replace(/[),.;:!?]+$/gu, '')
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(rootPath), resolve(candidatePath))
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')
}

function filePathFromUrl(value: string): string | null {
  if (value.startsWith('file://')) {
    try {
      return fileURLToPath(value)
    } catch {
      return null
    }
  }
  if (value.startsWith('http://') || value.startsWith('https://')) return null
  return value
}

function dataImage(value: string): { bytes: Buffer; mime: string } | null {
  const match = value.match(/^data:(image\/[a-z0-9.+-]+)(;base64)?,([\s\S]*)$/iu)
  if (!match) return null
  try {
    const payload = match[3] ?? ''
    return {
      bytes: match[2] ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload)),
      mime: match[1]
    }
  } catch {
    return null
  }
}

function candidateIdentity(value: string): string {
  const data = dataImage(value)
  if (data) return `data:${createHash('sha256').update(data.bytes).digest('hex')}`
  const path = filePathFromUrl(value)
  return path ? resolve(path) : value
}

function safeFilename(value: string, fallback: string): string {
  const normalized = basename(value)
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/^-+|-+$/gu, '')
  return normalized || fallback
}

function imageReferences(value: string, surface: 'prose' | 'tool'): ImageCandidate[] {
  const candidates = new Map<string, ImageCandidate>()
  const add = (source: string, filename?: string): void => {
    const cleaned = trimReference(source)
    if (!cleaned || (!cleaned.startsWith('data:image/') && !isImagePath(cleaned))) return
    const identity = candidateIdentity(cleaned)
    if (!candidates.has(identity)) candidates.set(identity, { source: cleaned, filename })
  }

  for (const match of value.matchAll(MARKDOWN_IMAGE_PATTERN)) add(match[1] ?? '')
  const pattern = surface === 'tool' ? PRODUCED_IMAGE_REFERENCE_PATTERN : IMAGE_REFERENCE_PATTERN
  for (const match of value.matchAll(pattern)) add(match[0])
  return [...candidates.values()]
}

function imagePart(part: AgentPart): part is Extract<AgentPart, { type: 'file' }> {
  return (
    part.type === 'file' && (part.mime.toLowerCase().startsWith('image/') || isImagePath(part.url))
  )
}

function isStaleProjectImage(value: string, context: ArtifactContext): boolean {
  if (context.scope !== 'project') return false
  const sourcePath = filePathFromUrl(value)
  if (!sourcePath || sourcePath.startsWith('data:')) return false
  const absolutePath = resolve(context.projectPath, sourcePath)
  const projectDataRoot = resolve(context.projectPath, PROJECT_DATA_DIRECTORY)
  return (
    isWithinRoot(projectDataRoot, absolutePath) && !isWithinRoot(context.artifactRoot, absolutePath)
  )
}

/** A file part this service injected into an assistant answer, as opposed to one
 *  a provider or a user attachment delivered. */
function isInjectedImagePart(part: Extract<AgentPart, { type: 'file' }>): boolean {
  return part.id.includes(':generated-image:')
}

/** An injected project image the answer no longer refers to. Only this
 *  service's own parts qualify, and only while they point at a plain project
 *  file outside the thread's artifact directory: those were adopted by the
 *  retired project-wide scan, not produced for the reader. */
function isOrphanedProjectImage(
  part: Extract<AgentPart, { type: 'file' }>,
  context: ArtifactContext,
  referencedPaths: Set<string>
): boolean {
  if (context.scope !== 'project' || !isInjectedImagePart(part)) return false
  const sourcePath = filePathFromUrl(part.url)
  if (!sourcePath || !isAbsolute(sourcePath)) return false
  const absolutePath = resolve(sourcePath)
  if (isWithinRoot(context.artifactRoot, absolutePath)) return false
  if (!isWithinRoot(context.projectPath, absolutePath)) return false
  return !referencedPaths.has(absolutePath)
}

function projectArtifactDirectory(thread: ProjectArtifactThread): string {
  return join(
    PROJECT_DATA_DIRECTORY,
    'work',
    thread.featureSlug ?? featureSlugFromTitle(thread.title),
    thread.id
  )
}

function promptPath(path: string): string {
  return toPosixPath(path)
}

async function atomicWriteBuffer(path: string, bytes: Buffer): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${createHash('sha1').update(path).digest('hex').slice(0, 12)}.tmp`
  try {
    await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    return metadata.isFile()
  } catch {
    return false
  }
}

/**
 * Captures image outputs from harness messages and tool results into stable,
 * user-visible locations. Chat artifacts are app-owned; project artifacts are
 * kept in the current thread's `.cio/work/<feature>/<threadId>` scratch
 * directory unless the agent already produced a file inside the project.
 */
export class GeneratedArtifactService {
  constructor(private readonly storage: StorageEngine) {}

  contextFor(thread: Thread, projectPath: string): ArtifactContext {
    // A chat owns one app-storage directory: `chats-cwd/<threadId>` is both the
    // directory its session runs in and the root its file tree mounts, so an
    // image is written, scanned, and cited in the same place. The older roots
    // stay readable for a chat that predates the consolidation.
    if (thread.projectId === INBOX_PROJECT_ID || thread.projectId === GLOBAL_BROWSER_PROJECT_ID) {
      const workspaceRoot = this.storage.resolve(
        thread.projectId === GLOBAL_BROWSER_PROJECT_ID
          ? browserThreadWorkspaceDirectory(thread.id)
          : chatThreadWorkspaceDirectory(thread.id)
      )
      return {
        scope: 'chat',
        projectPath: workspaceRoot,
        sourceRoot: workspaceRoot,
        artifactRoot: workspaceRoot,
        legacyArtifactRoots: [
          this.storage.resolve(join(LEGACY_CHATS_ARTIFACTS_DIRECTORY, thread.id)),
          this.storage.resolve(join(LEGACY_CHAT_ARTIFACTS_DIRECTORY, thread.id))
        ]
      }
    }
    return {
      scope: 'project',
      projectPath,
      sourceRoot: projectPath,
      artifactRoot: resolve(projectPath, projectArtifactDirectory(thread)),
      legacyArtifactRoots: []
    }
  }

  async synchronize(
    thread: Thread,
    projectPath: string,
    inputMessages: AgentMessage[]
  ): Promise<SynchronizationResult> {
    const context = this.contextFor(thread, projectPath)
    const messages = inputMessages.map((message) => ({
      ...message,
      parts: [...message.parts]
    }))
    // Explicit app-published artifacts already have validated presentation paths.
    const assistantMessages = messages.filter(
      (message) => message.role === 'assistant' && !message.inlineArtifact
    )
    if (assistantMessages.length === 0) return { messages: inputMessages, changed: false }

    const knownIdentities = new Set<string>()
    const candidatesByMessage = new Map<string, ImageCandidate[]>()
    let changed = false
    for (const message of assistantMessages) {
      const candidates = this.candidatesFromMessage(message)
      candidatesByMessage.set(message.id, candidates)
      const referencedPaths = new Set<string>()
      for (const candidate of candidates) {
        const referencedPath = referencePath(candidate.source, context)
        if (referencedPath) referencedPaths.add(referencedPath)
      }
      const nextParts: AgentPart[] = []
      for (const part of message.parts) {
        if (!imagePart(part)) {
          nextParts.push(part)
          continue
        }
        // Project `.cio/` is app-owned. Images there belong to the composer,
        // another thread, or another lifecycle surface unless they are inside
        // this thread's explicitly assigned artifact root. Remove stale parts
        // written by the old project-wide scanner before rendering them again.
        if (isStaleProjectImage(part.url, context)) {
          changed = true
          continue
        }
        // The scanner once attached every image it found in the project to the
        // latest answer, which turned an icon set the agent merely touched into
        // transcript attachments. An injected part survives only while the
        // message still mentions the image it points at.
        if (isOrphanedProjectImage(part, context, referencedPaths)) {
          changed = true
          continue
        }
        const materialized = await this.materialize(
          { source: part.url, mime: part.mime, filename: part.filename },
          context,
          message
        )
        if (!materialized) {
          nextParts.push(part)
          continue
        }
        knownIdentities.add(materialized.identity)
        nextParts.push({
          ...part,
          url: materialized.url,
          mime: materialized.mime,
          filename: materialized.filename
        })
        changed ||= part.url !== materialized.url || part.mime !== materialized.mime
      }
      message.parts = nextParts
    }

    for (const message of assistantMessages) {
      const candidates = candidatesByMessage.get(message.id) ?? []
      for (const candidate of candidates) {
        const materialized = await this.materialize(candidate, context, message)
        if (!materialized || knownIdentities.has(materialized.identity)) continue
        knownIdentities.add(materialized.identity)
        message.parts.push({
          type: 'file',
          id: `${message.id}:generated-image:${materialized.identity.slice(-24)}`,
          messageID: message.id,
          mime: materialized.mime,
          url: materialized.url,
          filename: materialized.filename
        })
        changed = true
      }
    }

    const latestAssistant = assistantMessages.at(-1)
    if (latestAssistant) {
      // Only this thread's own artifact directory is scanned. The project root
      // is not: a file being edited there is not an output of this turn, and
      // adopting one put unrelated icons and screenshots in the conversation.
      // Images an agent saves elsewhere in the project arrive through the
      // message's own references instead.
      const scanned = await this.scanImages(context.artifactRoot)
      for (const image of scanned) {
        const identity = resolve(image.path)
        if (knownIdentities.has(identity)) continue
        const materialized = await this.materialize(
          { source: image.path, mime: mimeForPath(image.path) },
          context,
          latestAssistant
        )
        if (!materialized || knownIdentities.has(materialized.identity)) continue
        knownIdentities.add(materialized.identity)
        latestAssistant.parts.push({
          type: 'file',
          id: `${latestAssistant.id}:generated-image:${materialized.identity.slice(-24)}`,
          messageID: latestAssistant.id,
          mime: materialized.mime,
          url: materialized.url,
          filename: materialized.filename
        })
        changed = true
      }
    }

    return { messages, changed }
  }

  artifactsFor(thread: Thread, projectPath: string, messages: AgentMessage[]): AgentArtifact[] {
    const context = this.contextFor(thread, projectPath)
    const artifacts = new Map<string, AgentArtifact>()
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const part of message.parts) {
        if (!imagePart(part)) continue
        const path = filePathFromUrl(part.url)
        if (!path || !isAbsolute(path)) continue
        const id = `${message.id}:${resolve(path)}`
        if (artifacts.has(id)) continue
        artifacts.set(id, {
          id,
          kind: 'image',
          filename: part.filename ?? basename(path),
          mime: part.mime || mimeForPath(path),
          path: resolve(path),
          url: pathToFileURL(resolve(path)).toString(),
          messageId: message.id,
          createdAt: message.createdAt,
          scope: context.scope,
          relativePath: isWithinRoot(context.projectPath, path)
            ? relative(context.projectPath, path)
            : undefined
        })
      }
    }
    return [...artifacts.values()].sort(
      (left, right) =>
        right.createdAt - left.createdAt || left.filename.localeCompare(right.filename)
    )
  }

  private candidatesFromMessage(message: AgentMessage): ImageCandidate[] {
    const candidates = new Map<string, ImageCandidate>()
    const add = (candidate: ImageCandidate): void => {
      const identity = candidateIdentity(candidate.source)
      if (!candidates.has(identity)) candidates.set(identity, candidate)
    }

    for (const part of message.parts) {
      if (part.type === 'text') {
        for (const candidate of imageReferences(part.text, 'prose')) add(candidate)
      } else if (part.type === 'tool') {
        const output = part.state.output ?? ''
        for (const candidate of imageReferences(output, 'tool')) add(candidate)
        for (const candidate of imageReferences(JSON.stringify(part.state.input), 'tool')) {
          add(candidate)
        }
      }
    }
    return [...candidates.values()]
  }

  private async materialize(
    candidate: ImageCandidate,
    context: ArtifactContext,
    message: AgentMessage
  ): Promise<MaterializedImage | null> {
    const imageData = dataImage(candidate.source)
    let sourcePath: string | null = null
    let bytes: Buffer | null = null
    let mime = candidate.mime?.startsWith('image/') ? candidate.mime : undefined

    if (imageData) {
      bytes = imageData.bytes
      mime = imageData.mime
    } else {
      const rawPath = filePathFromUrl(candidate.source)
      if (!rawPath) return null
      sourcePath = isAbsolute(rawPath) ? rawPath : resolve(context.sourceRoot, rawPath)
      if (!(await regularFile(sourcePath))) return null
      mime ??= mimeForPath(sourcePath)
      const existingPath = resolve(sourcePath)
      if (
        isWithinRoot(context.artifactRoot, existingPath) ||
        context.legacyArtifactRoots.some((root) => isWithinRoot(root, existingPath)) ||
        (context.scope === 'project' && isWithinRoot(context.projectPath, existingPath))
      ) {
        return {
          path: existingPath,
          url: pathToFileURL(existingPath).toString(),
          mime,
          filename: candidate.filename ?? basename(existingPath),
          identity: existingPath
        }
      }
    }
    if (!mime?.startsWith('image/')) return null

    const sourceIdentity = imageData
      ? `data:${createHash('sha256').update(imageData.bytes).digest('hex')}`
      : resolve(sourcePath ?? '')
    const keepSource =
      context.scope === 'project' &&
      sourcePath !== null &&
      isWithinRoot(context.projectPath, sourcePath)
    const finalPath =
      keepSource && sourcePath
        ? resolve(sourcePath)
        : join(
            context.artifactRoot,
            `${safeFilename(
              candidate.filename ?? (sourcePath ? basename(sourcePath) : ''),
              `generated-${message.id.slice(-10)}`
            ).replace(
              /\.[^.]+$/u,
              ''
            )}-${createHash('sha1').update(sourceIdentity).digest('hex').slice(0, 12)}${this.extensionFor(mime, sourcePath)}`
          )

    if (!keepSource) {
      await ensureDir(context.artifactRoot)
      if (!(await regularFile(finalPath))) {
        const content = bytes ?? (sourcePath ? await readFile(sourcePath) : null)
        if (!content) return null
        await atomicWriteBuffer(finalPath, content)
      }
    }

    return {
      path: finalPath,
      url: pathToFileURL(finalPath).toString(),
      mime,
      filename: candidate.filename ?? basename(finalPath),
      identity: resolve(finalPath)
    }
  }

  private extensionFor(mime: string, sourcePath: string | null): string {
    const sourceExtension = sourcePath ? extname(sourcePath).toLowerCase() : ''
    if (IMAGE_EXTENSIONS.has(sourceExtension)) return sourceExtension
    const extension = Object.entries(IMAGE_MIME_TYPES).find(([, value]) => value === mime)?.[0]
    return extension ?? '.png'
  }

  private async scanImages(rootPath: string): Promise<ScannedImage[]> {
    const results: ScannedImage[] = []
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_SCAN_DEPTH || results.length >= MAX_SCAN_FILES) return
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (results.length >= MAX_SCAN_FILES) return
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name))
            await visit(join(directory, entry.name), depth + 1)
          continue
        }
        if (!entry.isFile() || !IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
        const path = join(directory, entry.name)
        try {
          const metadata = await lstat(path)
          results.push({ path, modifiedAt: metadata.mtimeMs })
        } catch {
          // A file can disappear while an agent is still writing its output.
        }
      }
    }
    await visit(rootPath, 0)
    return results.sort((left, right) => right.modifiedAt - left.modifiedAt)
  }
}

/**
 * The workspace a standalone conversation owns, storage-root-relative, or null
 * for a real project thread.
 *
 * A chat, an assistant task and a browser side chat each own one directory, and
 * each delivers requested assets through the inline artifact pipeline. A project
 * thread instead saves generated files into `.cio/work/<feature>/`. Keeping the
 * three standalone scopes together is what stops an assistant thread from being
 * handed the project rule ("save the bitmap and include it as a Markdown
 * image"), which is the exact opposite of the inline render contract the same
 * turn also carries.
 */
function standaloneWorkspaceDirectory(
  thread: Pick<Thread, 'projectId' | 'id' | 'assistantId'>
): string | null {
  if (thread.projectId === GLOBAL_BROWSER_PROJECT_ID)
    return browserThreadWorkspaceDirectory(thread.id)
  if (thread.projectId === ASSISTANT_SPACE_ID)
    return assistantThreadWorkspaceDirectory(thread.id, thread.assistantId)
  if (thread.projectId === INBOX_PROJECT_ID) return chatThreadWorkspaceDirectory(thread.id)
  return null
}

export function artifactInstruction(
  thread: Pick<Thread, 'projectId' | 'id' | 'title' | 'featureSlug' | 'assistantId'>,
  options?: { chatWorkspaceRoot?: string; chatFileSystemMode?: boolean }
): string {
  const standaloneDirectory = standaloneWorkspaceDirectory(thread)
  if (standaloneDirectory !== null) {
    const relativeRoot = `${promptPath(standaloneDirectory)}/`
    const absoluteRoot = options?.chatWorkspaceRoot
    const rootLabel = absoluteRoot ? `${relativeRoot} (absolute: ${absoluteRoot})` : relativeRoot
    const owner = thread.projectId === ASSISTANT_SPACE_ID ? 'this assistant' : 'this chat'
    const destinationRule = `Save every file you create for the user there: images, Markdown, documents, generated code, exports, anything. That directory is the pre-authorized workspace of ${owner}: reading and writing inside it never requires approval, and everything you save there appears in the Files panel for the user. Keep filenames descriptive.`
    const deliveryRule =
      'Write the actual asset there before you answer: when the user asked for an image, graphic, HTML or SVG, do the file, then render it with the artifact render operation. Describing an asset in the reply is not delivering it.'
    const boundaryRule = options?.chatFileSystemMode
      ? 'If the user asks for a file at a specific location outside that directory, honor the explicitly requested path.'
      : `Anything outside that directory is gated: if the user asks you to create or touch files anywhere else on their file system, do not do it silently; tell them to turn on File System mode for ${owner} so that gate opens.`
    return [
      `Your workspace directory in ${owner} is ${rootLabel}.`,
      destinationRule,
      deliveryRule,
      boundaryRule
    ].join(' ')
  }
  const artifactDirectory = promptPath(projectArtifactDirectory(thread))
  return `When you generate an image while working on this project and the user does not specify a destination, save the bitmap under ${artifactDirectory}/ and include it as an image output or Markdown image. If the user specifies a project path, honor that path instead.`
}
