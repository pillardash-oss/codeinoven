import type { SpeechSegment } from './types'

const MAX_SEGMENT_CHARACTERS = 480
// Kokoro-class TTS engines reject any input beyond 510 tokenizer tokens. The
// hard cap above bounds characters, but dense scripts (CJK) tokenize at roughly
// one token per character and overflow well before it. Budget every segment
// conservatively below the engine ceiling: CJK glyphs weigh 1.5 tokens each,
// other non-ASCII scripts 0.6, ASCII prose about 0.3.
const MAX_SEGMENT_TOKENS = 400
const WIDE_TOKENS_PER_CHAR = 1.5
const MIDDLE_TOKENS_PER_CHAR = 0.6
const ASCII_TOKENS_PER_CHAR = 0.3

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

function charTokens(code: number): number {
  const wide =
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x30000 && code <= 0x3134f)
  if (wide) return WIDE_TOKENS_PER_CHAR
  if (code >= 0x80) return MIDDLE_TOKENS_PER_CHAR
  return ASCII_TOKENS_PER_CHAR
}

function estimatedTokens(value: string): number {
  let tokens = 0
  for (const char of value) tokens += charTokens(char.codePointAt(0) ?? 0)
  return tokens
}

/** Splits a single over-budget piece into chunks that respect both budgets. */
function chunkWithinBudgets(value: string): string[] {
  const chunks: string[] = []
  let current = ''
  let currentTokens = 0
  for (const char of value) {
    const weight = charTokens(char.codePointAt(0) ?? 0)
    if (
      current.length > 0 &&
      (current.length + 1 > MAX_SEGMENT_CHARACTERS || currentTokens + weight > MAX_SEGMENT_TOKENS)
    ) {
      chunks.push(current)
      current = ''
      currentTokens = 0
    }
    current += char
    currentTokens += weight
  }
  if (current) chunks.push(current)
  return chunks
}

function sentences(value: string): string[] {
  const pieces = value.match(/[^.!?]+(?:[.!?]+|$)/gu) ?? [value]
  const segments: string[] = []
  let pending = ''
  let pendingTokens = 0
  const pushPending = (): void => {
    if (!pending) return
    segments.push(pending)
    pending = ''
    pendingTokens = 0
  }
  for (const piece of pieces.map((item) => item.trim()).filter(Boolean)) {
    const pieceTokens = estimatedTokens(piece)
    if (
      pending &&
      (pending.length + piece.length + 1 > MAX_SEGMENT_CHARACTERS ||
        pendingTokens + pieceTokens + 1 > MAX_SEGMENT_TOKENS)
    ) {
      pushPending()
    }
    if (piece.length > MAX_SEGMENT_CHARACTERS || pieceTokens > MAX_SEGMENT_TOKENS) {
      pushPending()
      for (const chunk of chunkWithinBudgets(piece)) segments.push(chunk)
      continue
    }
    pending = pending ? `${pending} ${piece}` : piece
    pendingTokens += pieceTokens + 1
  }
  pushPending()
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
