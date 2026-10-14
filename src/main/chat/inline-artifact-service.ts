import { open, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMessage, AgentPart } from '../../lib/types'
import { previewTypeForPath, type PreviewType } from '../../lib/preview-types'
import { isInsideProject } from '../preview/served-folder'
import { requiredString } from '../utilities/utility-orchestration/utility-input'

/**
 * What a requested file turned out to be. HTML and SVG arrive as text and render
 * through the Markdown artifact fence; every media type is published as a file
 * part streamed from `appfile://`.
 */
type ArtifactFormat = { kind: 'html' | 'svg' } | { kind: 'media'; type: PreviewType }

/**
 * Classify once, so the size check and the published part read one answer. Which
 * extensions count as media, and how large each may be, comes from the shared
 * `preview-types` table that `appfile://` serves from: a type the app can stream
 * is exactly a type this pipeline can publish.
 *
 * A type served only as a document has a viewer of its own in the file tree but
 * no inline conversation surface, so it is refused here rather than published as
 * a chip that renders nothing.
 */
function artifactFormat(path: string): ArtifactFormat | null {
  const extension = extname(path).toLowerCase()
  if (extension === '.html' || extension === '.htm') return { kind: 'html' }
  if (extension === '.svg') return { kind: 'svg' }
  const type = previewTypeForPath(path)
  if (!type || type.kind === 'document') return null
  return { kind: 'media', type }
}

/** Resolve and validate before publishing. Media stays on disk and streams through appfile. */
export async function inlineArtifactMessage(
  input: Record<string, unknown>,
  context: { projectId: string; threadId: string; root: string }
): Promise<AgentMessage> {
  const requested = requiredString(input['path'], 'path', 4096)
  const root = await realpath(context.root)
  const path = await realpath(isAbsolute(requested) ? requested : resolve(root, requested))
  if (!isInsideProject(root, path))
    throw new Error('Artifact path must be inside this thread workspace')
  const format = artifactFormat(path)
  if (!format)
    throw new Error('Unsupported artifact format; use HTML, SVG, an image, audio or video')
  const handle = await open(path, 'r')
  const id = `cio-artifact-${randomUUID()}`
  const parts: AgentPart[] = []
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size === 0)
      throw new Error('Artifact must be a nonempty file')
    if (format.kind === 'media') {
      if (metadata.size > format.type.maxBytes)
        throw new Error('Artifact exceeds the file preview size limit')
      const encoded = relative(root, path).split(sep).map(encodeURIComponent).join('/')
      parts.push({
        type: 'file',
        id: `${id}-media`,
        messageID: id,
        mime: format.type.mime,
        filename: basename(path),
        url: `appfile://thread/${context.projectId}/${context.threadId}/${encoded}?v=${metadata.mtimeMs}`
      })
    } else {
      if (metadata.size >= 64000)
        throw new Error('HTML/SVG artifacts must be smaller than 64000 bytes')
      const buffer = Buffer.alloc(64000)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead >= buffer.length) throw new Error('HTML/SVG artifact exceeds the size limit')
      const source = buffer.subarray(0, bytesRead).toString('utf8')
      const longest = Math.max(
        2,
        ...Array.from(source.matchAll(/~+/gu), (match) => match[0].length)
      )
      const fence = '~'.repeat(longest + 1)
      parts.push({
        type: 'text',
        id: `${id}-preview`,
        messageID: id,
        phase: 'final_answer',
        text: `${fence}artifact-${format.kind === 'svg' ? 'svg' : 'html'}\n${source}\n${fence}`
      })
    }
  } finally {
    await handle.close()
  }
  const now = Date.now()
  return {
    id,
    role: 'assistant',
    inlineArtifact: true,
    origin: 'orchestrator',
    visibility: 'conversation',
    parts,
    createdAt: now,
    completedAt: now
  }
}
