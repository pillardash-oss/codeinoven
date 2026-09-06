/**
 * Greeting-only prompt exclusion for model-ranking capture.
 *
 * A first user message that is nothing but a greeting ("hello", "hi",
 * "good morning", trivial variants) carries no task signal, so it never
 * opens a ranking snapshot and never consumes judge tokens. Matching is
 * intentionally conservative: trim, lowercase, strip punctuation, then match
 * the small explicit list below. Mixed messages such as "hi, fix the build"
 * normalize to something outside the list and remain fully eligible.
 * Documented capture semantics — extend the list, never add fuzzy matching.
 */

/** The explicit greeting list, already normalized (lowercase, no punctuation). */
const GREETING_PHRASES: readonly string[] = [
  'hello',
  'hi',
  'hey',
  'yo',
  'sup',
  'hiya',
  'howdy',
  'greetings',
  'good morning',
  'good afternoon',
  'good evening',
  'good day',
  'hello there',
  'hi there',
  'hey there'
]

/** Whether the prompt is a greeting-only message that must not be captured. */
export function isGreetingOnly(text: string): boolean {
  const normalized = normalizeForGreetingMatch(text)
  if (normalized === '') return false
  return GREETING_PHRASES.includes(normalized)
}

/** Trim, lowercase, strip punctuation, and collapse whitespace. */
function normalizeForGreetingMatch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
