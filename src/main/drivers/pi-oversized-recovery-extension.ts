/**
 * Generated TypeScript source for the app-owned Pi oversized-request recovery
 * extension. It is composed into the single "cio-core-tools" extension module
 * (see pi-cio-core-tools-extension.ts) and loaded with the driver's pi RPC
 * process.
 *
 * Why this exists: a provider can reject a request whose serialized body
 * exceeds a hard byte limit (e.g. "Request body exceeds the 4.5 MiB limit").
 * pi's compaction only summarizes the older part of the transcript and keeps a
 * recent tail intact, so when the tail itself carries multi-hundred-KB base64
 * image tool results, compaction cannot shrink the request below the limit —
 * every compaction keeps the oversized bytes.
 *
 * The driver arms this extension (via a handoff flag file) when an
 * oversized-request failure is being recovered. While armed, the `context`
 * hook — fired before every LLM call with a deep copy of the messages —
 * replaces image parts and oversized text parts with short placeholders in the
 * REQUEST copy only. The session transcript keeps the originals; nothing is
 * destructively removed. The driver disarms the flag as soon as a provider
 * request succeeds again.
 */

/** Absolute path of the per-session arm/disarm flag file. */
const FLAG_PATH = '__CIO_OVERSIZED_FLAG_PATH__'

/** Text parts above this byte size are replaced with a notice while armed. */
const MAX_TEXT_BYTES = 384_000

export function piOversizedRecoveryExtension(): string {
  return `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readFileSync, statSync } from 'node:fs'

const FLAG_PATH = '${FLAG_PATH}'
const MAX_TEXT_BYTES = ${MAX_TEXT_BYTES}

interface ContentPart {
  type: string
  text?: string
  [key: string]: unknown
}

interface AgentMessage {
  role: string
  content: string | ContentPart[] | undefined
  [key: string]: unknown
}

let cachedArmed: boolean | undefined
let cachedMtimeMs = -1

function readArmed(): boolean {
  try {
    const mtimeMs = statSync(FLAG_PATH).mtimeMs
    if (mtimeMs === cachedMtimeMs && cachedArmed !== undefined) return cachedArmed
    cachedMtimeMs = mtimeMs
    const raw = readFileSync(FLAG_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    cachedArmed =
      typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)[ARMED_KEY] === true
    return cachedArmed
  } catch {
    return false
  }
}

function isImagePart(part: ContentPart): boolean {
  return part.type === 'image'
}

function partBytes(part: ContentPart): number {
  return part.text === undefined ? 0 : Buffer.byteLength(part.text, 'utf-8')
}

function stripParts(content: ContentPart[]): ContentPart[] {
  let changed = false
  const next = content.map((part) => {
    if (isImagePart(part)) {
      changed = true
      return {
        type: 'text',
        text: '[image removed from the provider request to fit its size limit; the original image is preserved in the session transcript]'
      }
    }
    if (part.type === 'text' && partBytes(part) > MAX_TEXT_BYTES) {
      changed = true
      return {
        type: 'text',
        text:
          (part.text ?? '').slice(0, MAX_TEXT_BYTES) +
          '\\n[truncated from the provider request to fit its size limit; the full output is preserved in the session transcript]'
      }
    }
    return part
  })
  return changed ? next : content
}

export default function (pi: ExtensionAPI): void {
  pi.on('context', async (event) => {
    if (!readArmed()) return undefined
    const messages = event.messages as AgentMessage[]
    let changed = false
    const next = messages.map((message) => {
      if (!Array.isArray(message.content)) return message
      const stripped = stripParts(message.content)
      if (stripped === message.content) return message
      changed = true
      return { ...message, content: stripped }
    })
    if (!changed) return undefined
    return { messages: next }
  })
}
`
}
