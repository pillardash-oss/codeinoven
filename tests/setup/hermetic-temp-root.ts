/// <reference types="node" />

import { tmpdir } from 'node:os'

/**
 * Give every test run the temp root CI has.
 *
 * `os.tmpdir()` honours TMPDIR/TMP/TEMP, and processes that launch the suite
 * point those at their own scratch: CodeInOven's agent harness uses
 * `.cio/tmp/pi` *inside the repository*, and a chat harness uses a deep
 * per-thread `chats-cwd/<id>/.cio/tmp`. Both are legitimate places to keep
 * scratch, and both break suites that describe the platform rather than the
 * app:
 *
 * - a `mkdtemp(tmpdir())` directory below the checkout makes Git discover the
 *   repository above it and resolve bare specifiers through the checkout's own
 *   `node_modules`, the opposite of what `git-service`, `repository-service` and
 *   `bundled-pi-harness` assert;
 * - a deep temp root overflows `sun_path`, so the cross-instance bus tests time
 *   out waiting for a socket that could never bind;
 * - a temp root under `~/.config/...` carries a `config` segment the sensitive
 *   block list treats as protected, so the permission-policy suite sees a temp
 *   file it must ask about.
 *
 * GitHub Actions sets TMPDIR to `/tmp`, so none of that appears in CI. Whenever
 * the configured temp root differs from the platform temp directory resolved
 * with those variables ignored, this swaps in the platform one, which makes a
 * local run use the same temp layout as CI. When they already agree (CI, and a
 * stock shell) it changes nothing.
 *
 * This is a `globalSetup` entry, not a `setupFile`: it must run once in Node
 * before the workers spawn. As a per-file setup file its `node:*` imports broke
 * the jsdom renderer suites under the project's `browser` resolve condition.
 */

/** The platform temp directory as if TMPDIR/TMP/TEMP were never set. */
function systemTempRoot(): string {
  const saved = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR
  }
  delete process.env.TMPDIR
  delete process.env.TMP
  delete process.env.TEMP
  try {
    return tmpdir()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const configuredTempRoot = tmpdir()

/** Set once for the whole run, before the workers inherit the environment. */
export default function setup(): void {
  const tempRoot = systemTempRoot()
  if (configuredTempRoot === tempRoot) return
  process.env.TMPDIR = tempRoot
  process.env.TMP = tempRoot
  process.env.TEMP = tempRoot
}
