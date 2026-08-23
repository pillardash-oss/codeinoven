import type { SpeechSegment } from './types'

const MAX_SEGMENT_CHARACTERS = 480

function inlineText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1 link')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/[*_~]+/gu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function sentences(value: string): string[] {
  const pieces = value.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [value]
  const segments: string[] = []
  let pending = ''
  for (const piece of pieces.map((item) => item.trim()).filter(Boolean)) {
    if (pending && pending.length + piece.length + 1 > MAX_SEGMENT_CHARACTERS) {
      segments.push(pending)
      pending = ''
    }
    if (piece.length > MAX_SEGMENT_CHARACTERS) {
      if (pending) segments.push(pending)
      pending = ''
      for (let offset = 0; offset < piece.length; offset += MAX_SEGMENT_CHARACTERS) {
        segments.push(piece.slice(offset, offset + MAX_SEGMENT_CHARACTERS))
      }
    } else {
      pending = pending ? `${pending} ${piece}` : piece
    }
  }
  if (pending) segments.push(pending)
  return segments
}

/** Deterministic Markdown-to-speech normalization without rendering HTML. */
export function normalizeSpeechMarkdown(
  markdown: string,
  includeCodeBlocks = false
): SpeechSegment[] {
  const output: Array<Omit<SpeechSegment, 'id' | 'index'>> = []
  let inCode = false
  let code: string[] = []
  const flushCode = (): void => {
    if (includeCodeBlocks && code.length > 0) {
      const text = inlineText(code.join(' '))
      if (text) output.push({ text, kind: 'code' })
    }
    code = []
  }
  for (const rawLine of markdown.replace(/\r\n?/gu, '\n').split('\n')) {
    if (/^\s*```/u.test(rawLine)) {
      if (inCode) flushCode()
      inCode = !inCode
      continue
    }
    if (inCode) {
      code.push(rawLine)
      continue
    }
    const line = rawLine.trim()
    if (!line || /^[-*_]{3,}$/u.test(line)) continue
    const heading = /^#{1,6}\s+(.+)$/u.exec(line)
    const list = /^(?:[-+*]|\d+[.)])\s+(.+)$/u.exec(line)
    const kind = heading ? 'heading' : list ? 'list-item' : 'prose'
    const text = inlineText(heading?.[1] ?? list?.[1] ?? line.replace(/^>\s?/u, ''))
    for (const segment of sentences(text)) output.push({ text: segment, kind })
  }
  if (inCode) flushCode()
  return output.map((segment, index) => ({
    ...segment,
    id: `segment-${index}`,
    index
  }))
}
