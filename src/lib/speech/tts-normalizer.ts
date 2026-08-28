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

/**
 * Blocks are packed from whole words so a segment boundary never cuts one in
 * half. Spaceless scripts (CJK) and pathological tokens (long URLs) have no
 * whitespace to split on, so anything longer than this is broken at CJK
 * punctuation first, then hard-split as a last resort.
 */
const LONG_UNIT_CHARACTERS = 24
const UNIT_BREAK_AFTER = /[.,;:!?)\]】」』。，、；：！？…〕〗〙〛]/u

function splitUnits(value: string): string[] {
  const units: string[] = []
  for (const word of value.split(/\s+/u)) {
    if (!word) continue
    if (word.length <= LONG_UNIT_CHARACTERS) {
      units.push(word)
      continue
    }
    let current = ''
    for (const char of word) {
      current += char
      if (current.length >= LONG_UNIT_CHARACTERS || UNIT_BREAK_AFTER.test(char)) {
        units.push(current)
        current = ''
      }
    }
    if (current) units.push(current)
  }
  return units
}

/** Greedily packs whole-word units into segments under both budgets. */
function packUnits(units: string[]): string[] {
  const segments: string[] = []
  let current = ''
  let currentTokens = 0
  for (const unit of units) {
    const unitTokens = estimatedTokens(unit)
    if (current) {
      if (
        current.length + 1 + unit.length > MAX_SEGMENT_CHARACTERS ||
        currentTokens + 1 + unitTokens > MAX_SEGMENT_TOKENS
      ) {
        segments.push(current)
        current = ''
        currentTokens = 0
      }
    }
    current = current ? `${current} ${unit}` : unit
    currentTokens += unitTokens + 1
  }
  if (current) segments.push(current)
  return segments
}

function sentences(value: string): string[] {
  return packUnits(splitUnits(value))
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
