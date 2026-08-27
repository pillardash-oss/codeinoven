/**
 * Deterministic pre-LLM sanitization of raw ASR transcripts.
 *
 * Whisper-family models occasionally loop content hundreds of times when audio
 * trails off ("URL URL URL…", "thanks for watching thanks for watching…", CJK
 * runs with no spaces). Small refine models truncate legitimate output to make
 * room for the loop and larger ones echo it verbatim, so collapsing the run
 * deterministically before cleanup sidesteps both. Rhetorical repetition below
 * the threshold ("no, no, no") is preserved.
 */

const REPETITION_RUN_THRESHOLD = 6

/** Upper bound on a repeating unit the character-level pass will detect
 * (covers known Whisper hallucination phrases while staying below the length
 * of coincidental long-phrase repetition in legitimate speech). */
const MAX_REPETITION_UNIT_CHARS = 60

function tokenKey(word: string): string {
  return word.replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase()
}

/** Collapse any single token repeated `minRun`+ times consecutively. */
function collapseWordRuns(text: string, minRun: number): string {
  const parts = text.split(/(\s+)/u)
  const words: string[] = []
  const separators: string[] = []
  for (let index = 0; index < parts.length; index += 2) {
    words.push(parts[index] ?? '')
    separators.push(parts[index + 1] ?? '')
  }
  if (words.length < minRun) return text

  const out: string[] = []
  let cursor = 0
  while (cursor < words.length) {
    const word = words[cursor]
    const key = tokenKey(word ?? '')
    if (!key) {
      out.push(word ?? '')
      cursor += 1
      continue
    }
    let run = 1
    while (cursor + run < words.length && tokenKey(words[cursor + run] ?? '') === key) run += 1
    if (run >= minRun) {
      // Keep one instance and its trailing separator; drop the looped tail.
      out.push(word ?? '', separators[cursor] ?? '')
    } else {
      for (let offset = 0; offset < run; offset += 1) {
        out.push(words[cursor + offset] ?? '', separators[cursor + offset] ?? '')
      }
    }
    cursor += run
  }
  return out.join('')
}

/**
 * Collapse any 2–60 char unit that repeats `minRun`+ times immediately after
 * itself. Catches multi-word loops and CJK loops where splitting yields one
 * unsplit token. An optional single space is allowed between repetitions
 * because a loop's final copy lacks the trailing separator of the earlier
 * copies ("thanks for watching thanks for watching …thanks for watching").
 */
function collapseCharacterRuns(text: string, minRun: number): string {
  const unit = `(.{2,${MAX_REPETITION_UNIT_CHARS}}?)`
  const repeats = `{${minRun - 1},}`
  const pattern = new RegExp(`${unit}(?:[ \\t]?\\1)${repeats}`, 'gsu')
  return text.replace(pattern, '$1')
}

/** Sanitize a raw transcript in place before it reaches a cleanup model. */
export function collapseRepetitiveArtifacts(text: string): string {
  if (!text.trim()) return text
  return collapseCharacterRuns(
    collapseWordRuns(text, REPETITION_RUN_THRESHOLD),
    REPETITION_RUN_THRESHOLD
  ).trimEnd()
}
