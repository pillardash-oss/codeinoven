import { performance } from 'node:perf_hooks'
import { Logger } from './logger'
import type { StartupTelemetry } from './startup-telemetry'

/**
 * Lifecycle diagnostics for the Electron main process.
 *
 * Owns the deterministic, privacy-preserving response to fatal startup and
 * runtime failures, structured lifecycle spans, and the logger-drain contract
 * that must precede resource teardown. Every diagnostic only records phase
 * names, durations, and sanitized error text — never paths, user content, or
 * credentials.
 */

/** One initialized resource that a fatal startup failure must close. */
export interface FatalStartupResource {
  /** Human-readable label used in the failure report (e.g. "database"). */
  name: string
  /** Close the resource. May throw; failures are recorded, not propagated. */
  close: () => void
}

export interface FatalStartupContext {
  error: unknown
  /** Application display name used in the user-facing error box. */
  appName: string
  /** Every resource initialized by the startup chain that must be closed. */
  resources?: FatalStartupResource[]
  /** Close the SQLite database (convenience; equivalent to a named resource). */
  closeDatabase?: () => void
  /** Show a blocking error dialog; only used when a window can be shown. */
  showErrorBox?: (title: string, message: string) => void
  /**
   * Quit the application process with the given exit code. When this throws or
   * returns without exiting, `handleFatalStartupFailure` falls back to
   * `process.exit`, so a failed quit can never leave a headless process alive.
   */
  quit?: (code: number) => void
  /** Optional startup telemetry whose final report is emitted before exit. */
  telemetry?: StartupTelemetry
  /** Injected current-time function (test seam). */
  now?: () => number
}

export interface FatalStartupOutcome {
  exitCode: number
  logged: boolean
  /** Every resource that was successfully closed, by name. */
  closed: string[]
  /** Every resource whose close callback threw, by name. */
  closeFailures: string[]
  /** Whether the quit callback itself threw (and process.exit was attempted). */
  quitFailed: boolean
  /** Whether an exit was actually invoked (quit callback or process.exit). */
  exited: boolean
}

export interface LifecycleSpan {
  name: string
  startMs: number
  endMs: number
  durationMs: number
}

/**
 * Structured lifecycle spans for the current process lifetime. Records open
 * spans and a bounded recent history of completed spans so diagnostics can
 * report "what ran and how long" without sensitive content.
 */
export class LifecycleDiagnostics {
  private readonly now: () => number
  private readonly open = new Map<string, { startMs: number; enteredAt: number }>()
  private readonly history: LifecycleSpan[] = []
  private readonly maxHistory = 50

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => performance.now())
  }

  /** Begin a named span; returns a bound end function for convenience. */
  begin(name: string): () => void {
    const startMs = this.now()
    this.open.set(name, { startMs, enteredAt: Date.now() })
    Logger.dev(`lifecycle span begin: ${name}`)
    return () => this.end(name)
  }

  /** End a named span and record it in the bounded history. */
  end(name: string): void {
    const open = this.open.get(name)
    if (!open) return
    this.open.delete(name)
    const endMs = this.now()
    const span: LifecycleSpan = {
      name,
      startMs: open.startMs,
      endMs,
      durationMs: Math.max(0, endMs - open.startMs)
    }
    this.history.push(span)
    if (this.history.length > this.maxHistory)
      this.history.splice(0, this.history.length - this.maxHistory)
    Logger.dev(`lifecycle span end: ${name} (${span.durationMs}ms)`)
  }

  /** Completed lifecycle spans, oldest first, in the bounded window. */
  spans(): LifecycleSpan[] {
    return [...this.history]
  }

  /** Names of spans still open at the time of the call. */
  openSpanNames(): string[] {
    return [...this.open.keys()]
  }
}

/**
 * Deterministically respond to a fatal startup failure: log the error, flush
 * the logger so the failure is durable, close every initialized resource,
 * show the blocking error box, and quit with a nonzero diagnostic exit code.
 * Guarantees the app never lingers as a headless process after a failed boot:
 * if the injected quit callback throws or returns without exiting, the process
 * is terminated with `process.exit(code)`.
 */
export async function handleFatalStartupFailure(
  context: FatalStartupContext
): Promise<FatalStartupOutcome> {
  const { error, appName, telemetry } = context
  const message = error instanceof Error ? error.message : String(error)
  Logger.error(`${appName} startup failed`, error)

  if (telemetry) {
    telemetry.stopEventLoopMonitor()
    telemetry.report('failed startup')
  }

  // The error box copy tells the user to export diagnostics, which reads the
  // durable log — so flush the logger before anything else can fail.
  let logged = false
  try {
    await Logger.flush()
    logged = true
  } catch {
    // Nothing more can be written; continue the teardown regardless.
  }

  // Close every resource the startup chain initialized, reporting each result
  // so the audit trail records exactly what was torn down and what failed.
  const closed: string[] = []
  const closeFailures: string[] = []
  const resources = [
    ...(context.resources ?? []),
    ...(context.closeDatabase ? [{ name: 'database', close: context.closeDatabase }] : [])
  ]
  for (const resource of resources) {
    try {
      resource.close()
      closed.push(resource.name)
    } catch (closeError) {
      closeFailures.push(resource.name)
      Logger.error(`Resource close failed during fatal startup exit: ${resource.name}`, closeError)
    }
  }

  try {
    context.showErrorBox?.(
      `${appName} could not start`,
      `${message}\n\nRestart ${appName}. If the problem continues, export diagnostics after the app opens.`
    )
  } catch {
    // The error box is best-effort; the process must still exit nonzero.
  }

  const exitCode = 1
  let quitFailed = false
  let exited = false
  try {
    if (context.quit) {
      context.quit(exitCode)
      exited = true
    }
  } catch {
    quitFailed = true
  }

  // Process-fail-safe: if there is no quit callback, or the quit callback threw
  // (e.g. `app.exit` itself failed), force the process to terminate nonzero so
  // a failed boot can never leave a headless process alive.
  if (!exited || quitFailed) {
    try {
      process.exit(exitCode)
      exited = true
    } catch {
      // process.exit does not normally throw; if it somehow does, there is
      // nothing more this process can do — the outcome still records it.
      exited = false
    }
  }

  return { exitCode, logged, closed, closeFailures, quitFailed, exited }
}

/**
 * Privacy-preserving process-wide crash diagnostics: route uncaught exceptions
 * and unhandled rejections through the Logger instead of letting Electron's
 * default dialog or a silent hang take over. Neither is fatal: a failed
 * background operation (e.g. a model download hitting ENOSPC) must never kill
 * the whole app. Both are logged with full context so failures remain fully
 * diagnosable; the app keeps running and the affected feature degrades.
 */
export function installProcessCrashDiagnostics(): void {
  process.on('uncaughtException', (error: Error) => {
    Logger.error('Uncaught exception (non-fatal; the app keeps running)', error)
  })

  process.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    Logger.error('Unhandled rejection (non-fatal; the app keeps running)', error)
  })
}

export const lifecycleDiagnostics = new LifecycleDiagnostics()
