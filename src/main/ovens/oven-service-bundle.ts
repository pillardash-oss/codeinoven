import { createHash } from 'node:crypto'

/**
 * Normalize an Oven service bundle to exactly one trailing newline.
 *
 * One build of `oven-service.mjs` has to hash to one revision no matter which
 * path delivers it, so the app that pushes the bundle, the standalone agent
 * installer that embeds it, and the published `cio-oven` CLI all normalize the
 * same way. This module stays free of Electron imports on purpose: the CLI runs
 * on the Oven, where nothing from the desktop app exists.
 */
export function normalizeServiceBundle(source: string): string {
  return `${source.replace(/\n+$/u, '')}\n`
}

/** The revision an Oven service bundle is identified by everywhere it travels. */
export function serviceBundleRevision(source: string): string {
  return createHash('sha256').update(normalizeServiceBundle(source)).digest('hex')
}

/**
 * Answers from a service bundle this app did not install.
 *
 * Each one is produced by the Oven's own older service, not by the request:
 *
 * - `spawn EINVAL` is how a bundle before the Windows command fix failed every
 *   harness version probe, because `npm install -g` puts a `.cmd` shim on PATH
 *   and `CreateProcess` cannot start one.
 * - The generic "install the service again" text was a fixed message that named
 *   no cause, and it is what an older bundle printed whenever it could not
 *   answer at all.
 * - A protocol mismatch means the bundle predates the contract this app sends.
 *
 * The app owns that file on the Oven, so any of these justifies replacing it.
 * A bundle that answers with its own request failure ("could not handle this
 * request") is deliberately not here: it ran the current code and explained
 * itself, and reinstalling would only repeat that answer.
 */
const STALE_SERVICE_ANSWERS: readonly RegExp[] = [
  /\bspawn EINVAL\b/u,
  /The Oven service is unavailable\. Check its Node runtime and install the service again\./u,
  /Oven protocol version mismatch/u
]

/**
 * How Node fails when it cannot even load a module, as opposed to a module that
 * loaded and refused a request. A service file that dies this way never answers
 * anything, so the only cure is replacing it, and the app owns that file. The
 * list is deliberately broad: waiting for each new way a bad bundle can crash
 * to be named first is what left an Oven broken for every request.
 */
const SERVICE_LOAD_CRASHES: readonly RegExp[] = [
  /\bis not defined in ES module scope\b/u,
  /\bSyntaxError\b/u,
  /\bERR_(?:MODULE_NOT_FOUND|REQUIRE_ESM|UNKNOWN_FILE_EXTENSION|INVALID_PACKAGE_CONFIG|IMPORT_ATTRIBUTE_MISSING)\b/u,
  /\bCannot find (?:package|module)\b/u,
  /\bdoes not provide an export named\b/u
]

/**
 * True when the service process crashed while loading.
 *
 * Only meaningful for a thrown failure (the remote command exited non-zero): a
 * service that loaded answers `{ ok: false }` instead, and its own errors may
 * legitimately mention a SyntaxError in the user's files.
 */
export function isServiceLoadCrash(message: string): boolean {
  return SERVICE_LOAD_CRASHES.some((pattern) => pattern.test(message))
}

/** True when a failure proves the Oven runs a bundle this app did not install. */
export function isStaleServiceFault(message: string): boolean {
  return STALE_SERVICE_ANSWERS.some((pattern) => pattern.test(message))
}

/**
 * True when an answer is a healthy probe from the revision that must be running.
 *
 * A service that is still shutting down keeps answering for a moment, and its
 * answer is not the result of an install. Reporting it made a finished update
 * look like a failed one: the app showed the old bundle's error (on Windows,
 * `spawn EINVAL` from a bundle that could not start npm's `.cmd` shims) while
 * the new file was already on disk. Only this shape counts as done, so the
 * caller can tell "replaced" from "still the old one" without guessing.
 */
export function isCurrentServiceAnswer(answer: string, revision: string): boolean {
  try {
    const parsed = JSON.parse(answer.replace(/^\uFEFF/u, '')) as {
      ok?: boolean
      value?: { serviceRevision?: unknown }
    }
    return parsed.ok === true && parsed.value?.serviceRevision === revision
  } catch {
    return false
  }
}

/**
 * The error a service answer carries, when it carries one.
 *
 * Read from the raw answer because a failed request is still a successful SSH
 * command: the service replies `{ ok: false, error }` on stdout, so the failure
 * only exists inside the payload.
 */
export function failedAnswerError(answer: string): string | null {
  if (!answer.includes('"ok":false')) return null
  try {
    const parsed = JSON.parse(answer.replace(/^\uFEFF/u, '')) as { ok?: boolean; error?: unknown }
    return parsed.ok === false && typeof parsed.error === 'string' ? parsed.error : null
  } catch {
    return null
  }
}
