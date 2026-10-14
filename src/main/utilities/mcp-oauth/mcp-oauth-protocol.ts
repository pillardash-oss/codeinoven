/**
 * The MCP OAuth implementation, loaded on first use.
 *
 * `@earendil-works/pi-mcp/oauth` is the spec-aligned OAuth 2.1 client the pi
 * harness ships   protected-resource metadata discovery, RFC 8707 resource
 * indicators, PKCE S256, dynamic client registration, issuer validation and
 * rotating-refresh-token handling, adapted from the official MCP TypeScript
 * SDK. Reimplementing that here would duplicate a spec implementation the app
 * cannot test against every authorization server.
 *
 * It is imported lazily because nothing about app startup needs it: only a user
 * authorizing an OAuth MCP server, or a turn renewing one's token, pays for it.
 */
export type McpOAuthProtocol = typeof import('@earendil-works/pi-mcp/oauth')

let loading: Promise<McpOAuthProtocol> | null = null

export function loadMcpOAuthProtocol(): Promise<McpOAuthProtocol> {
  loading ??= import('@earendil-works/pi-mcp/oauth')
  return loading
}
