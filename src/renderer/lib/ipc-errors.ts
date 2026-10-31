import type { GitRemoteIssue } from '$shared/types'

/**
 * Renderer-side normalization of an IPC rejection for display.
 *
 * A rejected `ipcRenderer.invoke` arrives wrapped
 * (`Error invoking remote method 'channel': <Name>Error: <message>`), so the
 * wrapper has to be stripped before the message can be shown to the user. The
 * main process already writes human-readable, user-safe messages for the
 * channels that surface them.
 *
 * The inner name is not always `Error`: a transport failure reaches the renderer
 * as `TypeError: fetch failed` and a validation one as `RangeError: …`, so the
 * prefix is matched by shape. Leaving it in put the whole
 * `Error invoking remote method 'github:startDeviceFlow': TypeError: …` sentence
 * in front of the user, which named the app's own plumbing instead of the
 * problem.
 */
export function ipcErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  const message = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^[A-Za-z]*Error:\s*/u, '')
    .trim()
  return message.length > 0 ? message : fallback
}

/**
 * A remote round trip that did not finish: the other end was unreachable,
 * refused this checkout, or has no such repository for this account.
 *
 * Main classifies it and reports it as data rather than a rejection, so
 * Electron never logs it, and `invokeGit` re-throws it here, on this side of
 * the boundary. Every git store keeps the failure handling it already has, and
 * the ones that can tell a remote verdict from an unexpected failure act on the
 * issue instead of turning it into an error banner.
 */
export class GitRemoteUnavailableError extends Error {
  readonly issue: GitRemoteIssue

  constructor(issue: GitRemoteIssue) {
    super(issue.message)
    this.name = 'GitRemoteUnavailableError'
    this.issue = issue
  }
}

/**
 * The remote verdict behind a failed git round trip, or null when the failure
 * was something else and belongs in the error banner every store already has.
 */
export function gitRemoteIssueOf(failure: unknown): GitRemoteIssue | null {
  return failure instanceof GitRemoteUnavailableError ? failure.issue : null
}
