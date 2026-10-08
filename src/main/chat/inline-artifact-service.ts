import { open, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMessage, AgentPart } from '../../lib/types'
import { mimeTypeForPath } from '../../lib/mime-types'
import { isInsideProject } from '../preview/served-folder'
import { requiredString } from '../utilities/utility-orchestration/utility-input'

const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
  '.mp4',
  '.webm',
  '.mov'
])

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
  const extension = extname(path).toLowerCase()
  const document = extension === '.html' || extension === '.htm' || extension === '.svg'
  const mime = mimeTypeForPath(path)
  if (!document && !MEDIA_EXTENSIONS.has(extension))
    throw new Error('Unsupported artifact format; use HTML, SVG, an image, audio or video')
  const handle = await open(path, 'r')
  const id = `cio-artifact-${randomUUID()}`
  const parts: AgentPart[] = []
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size === 0)
      throw new Error('Artifact must be a nonempty file')
    if (!document && metadata.size > (mime.startsWith('image/') ? 32 : 512) * 1024 * 1024)
      throw new Error('Artifact exceeds the file preview size limit')
    if (document) {
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
        text: `${fence}artifact-${extension === '.svg' ? 'svg' : 'html'}\n${source}\n${fence}`
      })
    } else {
      const encoded = relative(root, path).split(sep).map(encodeURIComponent).join('/')
      parts.push({
        type: 'file',
        id: `${id}-media`,
        messageID: id,
        mime,
        filename: basename(path),
        url: `appfile://thread/${context.projectId}/${context.threadId}/${encoded}?v=${metadata.mtimeMs}`
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
