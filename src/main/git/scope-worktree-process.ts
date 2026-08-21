import { execFile } from 'child_process'
import { accessSync, constants as fsConstants } from 'fs'
import { isAbsolute } from 'path'
import type { ScopeSetupCommandSpec } from '../../lib/types'
import { buildProcessEnvironment, resolveExecutablePath } from '../drivers/cli-environment'
import { Logger } from '../system/logger'

/** Upper bound on setup stdout captured in memory and streamed to the UI. */
export const MAX_SETUP_OUTPUT_CHARS = 64 * 1024

/** Structured result of a finished command. Output text is never persisted. */
export interface ScopeProcessResult {
  exitCode: number
  /** Bounded, in-memory-only output tail (never logged or persisted). */
  output: string
  timedOut: boolean
}

function gitExecutable(): string {
  const resolved = resolveExecutablePath('git', buildProcessEnvironment())
  if (!resolved) throw new Error('git is not available on this machine')
  return resolved
}

/** Resolve a setup command executable through the shared GUI-safe PATH. */
function resolveSetupExecutable(spec: ScopeSetupCommandSpec): string {
  const { executable } = spec
  if (isAbsolute(executable)) {
    try {
      accessSync(executable, fsConstants.X_OK)
      return executable
    } catch {
      throw new Error(`Setup executable is not runnable: ${executable}`)
    }
  }
  const resolved = resolveExecutablePath(executable, buildProcessEnvironment())
  if (!resolved) throw new Error(`Setup executable not found on PATH: ${executable}`)
  return resolved
}

/** Run `git` with structured arguments through the shared GUI-safe env, never a shell. */
export async function runGit(
  args: string[],
  options: { cwd: string; timeoutMs?: number } = { cwd: process.cwd() }
): Promise<string> {
  const command = gitExecutable()
  const { stdout, timedOut } = await runExecutable(
    command,
    args,
    options.cwd,
    options.timeoutMs ?? 60_000
  )
  if (timedOut) throw new Error(`git command timed out: git ${args[0] ?? ''}`)
  // Many git verbs (worktree remove, branch -D, fetch, …) legitimately emit no
  // output; only callers that need discovery output guard for it themselves.
  return stdout
}

/** Run one structured setup command sequentially with bounded in-memory output. */
export async function runSetupCommand(
  spec: ScopeSetupCommandSpec,
  options: { cwd: string; timeoutMs?: number }
): Promise<ScopeProcessResult> {
  const executable = resolveSetupExecutable(spec)
  const result = await runExecutable(
    executable,
    spec.args,
    options.cwd,
    options.timeoutMs ?? 600_000
  )
  return {
    exitCode: result.exitCode,
    output: result.stdout.slice(0, MAX_SETUP_OUTPUT_CHARS),
    timedOut: result.timedOut
  }
}

/**
 * Shell-free process runner. The executable is resolved with
 * `resolveExecutablePath` against `buildProcessEnvironment()` so the packaged
 * GUI resolves commands the same way harness processes do.
 */
function runExecutable(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolveResult, rejectResult) => {
    let settled = false
    const child = execFile(
      command,
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_SETUP_OUTPUT_CHARS * 2,
        windowsHide: true,
        env: buildProcessEnvironment()
      },
      (error, stdout) => {
        clearTimeout(timer)
        if (settled) return
        if (error) {
          settled = true
          // Non-zero exits are reported as results, not exceptions.
          const exitCode =
            typeof (error as NodeJS.ErrnoException & { code?: number | string }).code === 'number'
              ? ((error as { code?: number | string }).code as number)
              : 1
          resolveResult({ stdout, exitCode, timedOut: false })
          return
        }
        settled = true
        resolveResult({ stdout, exitCode: 0, timedOut: false })
      }
    )
    const timer = setTimeout(() => {
      Logger.error(`Setup command timed out after ${timeoutMs}ms: ${command}`)
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref()
    child.on('error', (error) => {
      if (settled) return
      clearTimeout(timer)
      settled = true
      rejectResult(error)
    })
  })
}

/** Escape a single string for use as one Git argument (never a shell string). */
export function gitConfigArgs(entries: ReadonlyArray<readonly [string, string]>): string[] {
  const args: string[] = []
  for (const [key, value] of entries) {
    args.push('-c', `${key}=${value}`)
  }
  return args
}
