/**
 * Timing shared by every transport that carries the app-owned utility gateway.
 *
 * A gateway call can be human-paced: `cio_ask_secret` holds the harness tool
 * call open while the user fetches the value, and the app owns that deadline
 * (the question timer, `questionTimeoutMs`). A transport that gives up before
 * the app does abandons the call while the card is still on screen, which is
 * exactly how a Slack token request was lost three times to a 60-second MCP
 * client timeout.
 *
 * So the app publishes one number to every transport, derived from the timer it
 * actually runs, and each transport waits that long instead of inventing its
 * own.
 */

/** Extra time a harness waits beyond the app's own human-decision deadline. */
export const GATEWAY_HARNESS_TIMEOUT_MARGIN_MS = 120_000

/** How long a harness transport must wait for one gateway call. */
export function gatewayHarnessTimeoutMs(questionTimeoutMs: number): number {
  return questionTimeoutMs + GATEWAY_HARNESS_TIMEOUT_MARGIN_MS
}

/**
 * Turn-scoped loopback endpoint a harness bridges its gateway tools through.
 * `timeoutMs` is the wait the transport must allow for one call.
 */
export interface UtilityGatewayEndpoint {
  url: string
  token: string
  timeoutMs: number
}
