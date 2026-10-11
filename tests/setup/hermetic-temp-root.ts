/// <reference types="node" />

import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Give every test run the temp root CI has.
 *
 * `os.tmpdir()` honours TMPDIR/TMP/TEMP, and CodeInOven points all three at
 * `.cio/tmp/pi` *inside* the repository so agent scratch stays in the repo. A
 * `mkdtemp(tmpdir())` directory is then a descendant of the checkout, so Git
 * discovers the repository above it and bare specifiers resolve through the
 * checkout's own `node_modules`. That is the exact opposite of what tests such
 * as `git-service`, `repository-service` and `bundled-pi-harness` assert
 * ("not a repository", "no ancestor node_modules"), so they only failed under
 * the agent harness while GitHub Actions, where TMPDIR is `/tmp`, stayed green.
 *
 * When the configured temp root sits inside a Git working tree, fall back to the
 * platform temp directory resolved with those variables ignored, so the local CI
 * gate runs the same temp layout as CI. On CI the configured root is already
 * outside any worktree and nothing changes.
 *
 * This is a `globalSetup` entry, not a `setupFile`: it must run once in Node
 * before the workers spawn. As a per-file setup file its `node:*` imports broke
 * the jsdom renderer suites under the project's `browser` resolve condition.
 */

function insideGitWorktree(directory: string): boolean {
  let current = directory
  for (;;) {
    if (existsSync(join(current, '.git'))) return true
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

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
  if (!insideGitWorktree(configuredTempRoot)) return
  const tempRoot = systemTempRoot()
  process.env.TMPDIR = tempRoot
  process.env.TMP = tempRoot
  process.env.TEMP = tempRoot
}
