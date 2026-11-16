import type { SpeechSegment } from './types'

const MAX_SEGMENT_CHARACTERS = 480
// Kokoro-class TTS engines reject any input beyond 510 tokenizer tokens, and
// that count is taken over the *phonemized* text: the engine maps every scalar
// of its G2P output through the phoneme vocabulary. English phonemization is
// roughly length-preserving (~1 token per character), spoken digits expand
// heavily ("259" becomes "two hundred fifty-nine"), and CJK glyphs surface
// several phonemes each. Weights below are calibrated against real engine
// rejections (a 480-character technical segment was rejected at 579 tokens).
const MAX_SEGMENT_TOKENS = 380
const WIDE_TOKENS_PER_CHAR = 2.0
const DIGIT_TOKENS_PER_CHAR = 6.0
const DEFAULT_TOKENS_PER_CHAR = 1.0

function inlineText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1 link')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/[*~]+/gu, '')
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\be\.g\.(?=\s|,|$)/giu, 'for example'],
  [/\bi\.e\.(?=\s|,|$)/giu, 'that is'],
  [/\betc\.(?=\s+\p{Ll})/gu, 'et cetera'],
  [/\betc\./gu, 'et cetera.'],
  [/\bvs\.?(?=\s)/giu, 'versus']
]

/**
 * Rewrites written forms the engine mispronounces or reads through. Invisible
 * break characters (soft hyphens, zero-width spaces) split a word's
 * phonemization in two, word-internal hyphens and underscores are read as
 * separate words, and spaced dashes become commas so the pause survives.
 */
function speakable(value: string): string {
  let text = value.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/gu, '')
  for (const [pattern, replacement] of ABBREVIATIONS) text = text.replace(pattern, replacement)
  return text
    .replace(/(?<![\d./:-])(\d+)\s*[-–]\s*(\d+)(?![\d./:-])/gu, '$1 to $2')
    .replace(/\s+[-\u2013\u2014]+\s+|\u2014/gu, ', ')
    .replace(/\S+/gu, (word) =>
      /[/@]/u.test(word) ? word : word.replace(/(?<=\p{L})[-‐‑_](?=\p{L})/gu, ' ')
    )
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/(?<=\p{L})([,;])(?=\p{L})/gu, '$1 ')
    .replace(/,\s*([,.;:!?])/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Headings and list items carry no stop of their own; give them one. */
function terminated(value: string): string {
  return /[.!?…:;,]$/u.test(value) ? value : `${value}.`
}

function charTokens(code: number): number {
  if (code >= 0x30 && code <= 0x39) return DIGIT_TOKENS_PER_CHAR
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
  return DEFAULT_TOKENS_PER_CHAR
}

function estimatedTokens(value: string): number {
  let tokens = 0
  for (const char of value) tokens += charTokens(char.codePointAt(0) ?? 0)
  return tokens
}

/**
 * Blocks are packed from whole words so a segment boundary never cuts one in
 * half. Long technical tokens (paths, URLs) break at their own separators so
 * they stay pronounceable, spaceless scripts (CJK) have no such marks and are
 * broken at CJK punctuation first, then hard-split as a last resort.
 */
const LONG_UNIT_CHARACTERS = 24
const UNIT_BREAK_AFTER = /[.,;:!?)\]】」』。，、；：！？…〕〗〙〛]/u
const UNIT_SEPARATOR_AFTER = /(?<=[/._\-=&:~+@#\\|<>])/u

function splitUnits(value: string): string[] {
  const units: string[] = []
  const pushPiece = (piece: string): void => {
    if (!piece) return
    if (piece.length <= LONG_UNIT_CHARACTERS) {
      units.push(piece)
      return
    }
    let current = ''
    for (const char of piece) {
      current += char
      if (current.length >= LONG_UNIT_CHARACTERS || UNIT_BREAK_AFTER.test(char)) {
        units.push(current)
        current = ''
      }
    }
    if (current) units.push(current)
  }
  for (const word of value.split(/\s+/u)) {
    if (!word) continue
    if (word.length <= LONG_UNIT_CHARACTERS) {
      units.push(word)
      continue
    }
    for (const piece of word.split(UNIT_SEPARATOR_AFTER)) pushPiece(piece)
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

const SENTENCE_END = /(?<=[.!?…。！？]["')\]]?)\s+(?=\S)/u
const CLAUSE_END = /(?<=[,;:，；：])\s+/u

function fits(current: string, next: string): boolean {
  const joined = current ? `${current} ${next}` : next
  return joined.length <= MAX_SEGMENT_CHARACTERS && estimatedTokens(joined) <= MAX_SEGMENT_TOKENS
}

/**
 * Every segment is synthesized on its own, so a cut mid-sentence loses the
 * intonation the punctuation ahead implies. Whole sentences are packed first,
 * an oversized sentence breaks at its clauses, and only an oversized clause
 * falls back to word packing.
 */
function packPieces(pieces: string[], split: (piece: string) => string[]): string[] {
  const segments: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (fits(current, piece)) {
      current = current ? `${current} ${piece}` : piece
      continue
    }
    if (current) segments.push(current)
    current = ''
    if (fits('', piece)) current = piece
    else segments.push(...split(piece))
  }
  if (current) segments.push(current)
  return segments
}

function sentences(value: string): string[] {
  const words = (clause: string): string[] => packUnits(splitUnits(clause))
  const clauses = (sentence: string): string[] => packPieces(sentence.split(CLAUSE_END), words)
  return packPieces(value.split(SENTENCE_END), clauses)
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
    const raw = speakable(inlineText(heading?.[1] ?? list?.[1] ?? line.replace(/^>\s?/u, '')))
    if (!raw) continue
    const text = kind === 'prose' ? raw : terminated(raw)
    for (const segment of sentences(text)) output.push({ text: segment, kind })
  }
  if (inCode) flushCode()
  return output.map((segment, index) => ({
    ...segment,
    id: `segment-${index}`,
    index
  }))
}
