/**
 * Detect an unavailable MCP, skill, or app utility at the tool-call boundary.
 * The chat engine uses this only when a tool call has already failed, so direct
 * utility use is never interrupted and ordinary final prose is not re-scanned.
 */

/** Capability markers that can identify an app-managed tool call. */
const TOOL_CAPABILITY =
  /(?:mcp|skills?|utilit(?:y|ies)|plugins?|extensions?|computer[\s_-]?use|image[\s_-]?descriptor)/iu

/** Provider/harness wording that indicates the requested tool could not be used. */
const UNAVAILABLE_TOOL_FAILURE =
  /(?:not found|unavailable|not available|does(?:n'?t| not) exist|not installed|cannot be found|could not be found|unknown (?:mcp|skill|utility|plugin|extension|tool))/iu

export interface CapabilityUnavailableClaim {
  /** The exact availability failure wording reported by the tool call. */
  phrase: string
  /** The capability marker that should guide the utility search. */
  target: string
  /** Bounded tool-call evidence used to build the internal steering prompt. */
  evidence: string
}

/**
 * Return an unavailable-capability claim only for a failed tool call that
 * names an MCP/skill/utility-like capability. A generic file or shell failure
 * therefore cannot trigger a utility-search nudge.
 */
export function detectUnavailableToolCall(
  toolName: string,
  toolError: string
): CapabilityUnavailableClaim | null {
  const name = toolName.trim()
  const error = toolError.trim()
  if (!name || !error) return null
  const failure = error.match(UNAVAILABLE_TOOL_FAILURE)
  if (!failure) return null
  const capability = `${name} ${error}`.match(TOOL_CAPABILITY)
  if (!capability) return null
  return {
    phrase: failure[0],
    target: capability[0],
    evidence: `${name}: ${error}`.slice(0, 1_500)
  }
}

/** Internal steering prompt for an availability failure observed on a tool call. */
export function searchNudgePromptForToolCall(
  claim: CapabilityUnavailableClaim,
  toolName: string,
  toolError: string
): string {
  const boundedToolName = toolName.slice(0, 500)
  const boundedToolError = toolError.slice(0, 1_000)
  return [
    'A tool call in the current turn reported that a requested capability is unavailable.',
    `Tool name: ${JSON.stringify(boundedToolName)}`,
    `Tool error: ${JSON.stringify(boundedToolError)}`,
    `The availability claim was "${claim.phrase}" about "${claim.target}".`,
    'This is an internal correction while the original task is still running, not a new user request. Preserve the original task and continue seamlessly.',
    `Call utility_search now to search for the requested capability, using a concise query derived from ${JSON.stringify(boundedToolName)}. The app may host it as an on-demand MCP, skill, utility, or service even when it is not directly available in the harness.`,
    'Only conclude that the capability does not exist in this session when the search result has notFound:true. If notFound:false, inspect the returned utilities, activate a relevant result, and use it when it helps answer the original request.',
    'Do not replace the original task with a discussion of tool availability. Update the original answer only as much as the search result requires.'
  ].join('\n\n')
}
