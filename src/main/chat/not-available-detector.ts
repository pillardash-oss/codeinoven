/**
 * Detect when an agent's final answer concludes that a capability, tool, or
 * MCP "does not exist" / "is not available", even though the app may host it
 * as an on-demand utility reachable through `utility_search`. The chat engine
 * uses this to nudge the agent into searching before it concludes.
 */

/** A capability-like noun that must appear near the negative claim. */
const CAPABILITY_NOUN =
  /\b(?:mcp(?: server)?|skill|tool|extension|plugin|server|capability|provider|model|harness|utility|integration|api|sdk|agent|add-?on)\b/giu

/** Phrasings that assert a capability is absent or unsupported. */
const NEGATIVE_CLAIM =
  /(?:does(?:n'?t| not) exist|is(?:n'?t| not) (?:available|installed|present|supported|accessible|bundled|included|here)|(?:is )?(?:not available|unavailable|not installed|not present|missing)|cannot be found|could not be found|not found|no such (?:thing|feature|capability|integration|tool|mcp|skill)|(?:there is|there's|there are|has) no|lacks)/giu

/** Characters of context scanned around a negative claim for a capability noun. */
const CONTEXT_WINDOW = 160

/**
 * Return the matched "does not exist"-style phrase when the text concludes a
 * capability is unavailable, or null when no such conclusion is present. The
 * capability-noun guard keeps false positives (e.g. "the file was not found")
 * from triggering a nudge.
 */
export function concludesCapabilityUnavailable(text: string): string | null {
  if (!text) return null
  for (const match of text.matchAll(NEGATIVE_CLAIM)) {
    const index = match.index ?? 0
    const start = Math.max(0, index - CONTEXT_WINDOW)
    const end = Math.min(text.length, index + match[0].length + CONTEXT_WINDOW)
    CAPABILITY_NOUN.lastIndex = 0
    if (CAPABILITY_NOUN.test(text.slice(start, end))) return match[0]
  }
  return null
}

/** Internal continuation prompt that nudges the agent to search before concluding. */
export function searchNudgePrompt(claimed: string): string {
  return [
    `Your previous answer concluded that "${claimed}".`,
    'You had the utility_search tool available in this session but did not use it before concluding.',
    'The app may host this capability as an on-demand utility (MCP, skill, or service) even when it is not directly available in the harness. Call utility_search to check, then rely on the explicit notFound field in the result: only when it is true may you conclude that the capability does not exist.',
    'Update your answer based on what you find.'
  ].join('\n\n')
}
