/** Stable built-in tag that grants the utility setup contract for one explicit turn. */
export const CIO_UTILITY_TAG = '@cio-utility'

/**
 * Versioned application-owned setup knowledge. This is deliberately source code rather
 * than a discoverable skill so its API contract cannot drift independently of the app.
 */
export const CIO_UTILITY_SETUP_PROMPT = `CodeInOven utility setup contract (version 1)

The user explicitly invoked @cio-utility. Help them create and install a skill, MCP server,
or plugin bundle through CodeInOven's turn-scoped utility_manage capability.

Rules:
- Resolve the user's intended utility type, scope, and harness targets from their request.
  Ask one focused question only when a missing choice would materially change the result.
- Research official upstream documentation when configuration details are uncertain and
  cite the source in your response.
- Never put API keys, tokens, passwords, Authorization values, or other secrets in the
  definition. Install the secret-free definition, then tell the user which environment
  variables or credentials to add in Utilities.
- Never edit harness config files or a project repository directly. The CodeInOven API is
  the only write path for this setup turn.
- Call utility_manage exactly once with action install_bundle after the bundle is complete.
- Report the installed utility names, target harnesses, scope, and any remaining credential
  step. Do not claim installation until the API returns the installed ids.

Bundle shape:
{
  "action": "install_bundle",
  "bundle": {
    "name": "Human-readable bundle name",
    "utilities": [{ "definition": { ... } }]
  }
}

Every definition contains:
- kind: "skill" or "mcp" (a plugin is a bundle with multiple definitions)
- name, description, enabled, activation ("on_demand" or "always")
- scope: {"level":"global"}, {"level":"project","projectId":"..."}, or
  {"level":"thread","projectId":"...","threadId":"..."}
- credentials: []
- harnessBindings: one or more {"harnessId":"codex|claude-code|opencode|cline|pi|muse",
  "strategy":"skill|mcp", "transportName":"stable-name"}

Skill config:
{"instructions":"Complete SKILL.md-compatible instructions with YAML name and description
frontmatter","supportingFiles":[]}

MCP config:
- stdio: {"transport":"stdio","command":"executable","args":["..."],
  "environment":{"NAME":"non-secret-value"}}
- remote: {"transport":"http|sse","url":"https://...","headers":{}}

Use global scope for capabilities intended across projects. Use project or thread scope only
when the user requests it and the required IDs are available in the setup context.`

export function isCioUtilityRequest(text: string): boolean {
  return /(^|\s)@cio-utility(?=\s|$|[.,:;!?])/iu.test(text)
}
