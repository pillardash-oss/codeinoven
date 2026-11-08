import { MEMORY_LIMITS } from './memory-constants'

/** Labels written before titles were derived properly are raw slices of this length. */
const LEGACY_SLICE_LENGTH = 80

const SENTENCE_END = /[.!?]/u
const CLAUSE_END = /[,;:]/u
const TRAILING_NOISE = /[\s,;:.]+$/u

/**
 * A memory's title, taken from its own words.
 *
 * A stored memory carries a title and its content, and the title is what the
 * panel, the proposal card, and the injected prompt show first. Slicing the
 * content at a character count produced titles that stop mid-sentence and
 * mid-word ("Remember to always announce yourself like I told you before, so
 * reviewers can kn"), which reads as broken rather than short. So the title is
 * the first sentence that fits, otherwise its longest run of whole clauses that
 * fits, and only a clause that is too long by itself is cut, on a word boundary,
 * with an ellipsis.
 */
export function memoryTitleFrom(
  content: string,
  maxCharacters: number = MEMORY_LIMITS.maxLabelCharacters
): string {
  const text = content.replace(/\s+/gu, ' ').trim()
  if (text.length === 0) return ''
  if (text.length <= maxCharacters) return cleanTitle(text)
  const sentence = firstSentenceOf(text)
  if (sentence.length <= maxCharacters) return cleanTitle(sentence)
  const fitting = longestClauseRun(sentence, maxCharacters)
  if (fitting.length > 0) return cleanTitle(fitting)
  return cutOnWordBoundary(sentence, maxCharacters)
}

/**
 * Repair a title read from disk that is a raw slice of its content: those
 * labels end mid-word or exactly on the old character cap, and re-deriving one
 * from the content it was cut from restores a complete title without touching
 * what the user wrote.
 */
export function repairSlicedTitle(label: string, content: string): string {
  if (label.length !== LEGACY_SLICE_LENGTH) return label
  if (!content.startsWith(label)) return label
  return memoryTitleFrom(content) || label
}

function cleanTitle(text: string): string {
  const cleaned = text.replace(TRAILING_NOISE, '').trim()
  return cleaned.length > 0 ? cleaned : text.trim()
}

function firstSentenceOf(text: string): string {
  for (let index = 0; index < text.length; index += 1) {
    if (SENTENCE_END.test(text[index]) && (index + 1 === text.length || text[index + 1] === ' ')) {
      return text.slice(0, index + 1)
    }
  }
  return text
}

/** The sentence's clauses, each keeping the separator that ended it. */
function clausesOf(sentence: string): string[] {
  const clauses: string[] = []
  let start = 0
  for (let index = 0; index < sentence.length; index += 1) {
    if (CLAUSE_END.test(sentence[index])) {
      clauses.push(sentence.slice(start, index + 1))
      start = index + 1
    }
  }
  if (start < sentence.length) clauses.push(sentence.slice(start))
  return clauses.map((clause) => clause.trim()).filter((clause) => clause.length > 0)
}

/** The longest run of leading clauses whose joined title still fits the cap. */
function longestClauseRun(sentence: string, maxCharacters: number): string {
  const clauses = clausesOf(sentence)
  let run = ''
  for (const clause of clauses) {
    const next = run.length === 0 ? clause : `${run} ${clause}`
    if (cleanTitle(next).length > maxCharacters) break
    run = next
  }
  return run
}

/** Last resort: cut a clause that cannot fit the cap on a word boundary. */
function cutOnWordBoundary(text: string, maxCharacters: number): string {
  const window = text.slice(0, maxCharacters + 1)
  const boundary = window.lastIndexOf(' ')
  const cut = boundary > 0 ? window.slice(0, boundary) : window.slice(0, maxCharacters)
  const cleaned = cleanTitle(cut)
  return cleaned.length > 0 ? `${cleaned}…` : ''
}
