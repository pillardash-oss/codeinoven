#!/usr/bin/env bun
/// <reference types="node" />

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { PACKAGED_SMOKE_OUTPUT_ENV } from '../src/main/system/packaged-smoke'
import type { StartupPhase, StartupTelemetrySnapshot } from '../src/main/system/startup-telemetry'

interface SmokeOptions {
  appDir: string
  iterations: number
  output: string | null
  target: 'linux' | 'mac' | 'win'
  timeoutMs: number
}

interface SmokeProof {
  schemaVersion: number
  startup: StartupTelemetrySnapshot
}

interface IterationResult {
  documentLoadedMs: number
  featuresReadyMs: number
  iteration: number
  proofReadyMs: number
  splashVisualReadyMs: number
  visualReadyMs: number
  workspaceReadyMs: number
  startup: StartupTelemetrySnapshot
}

function fail(message: string): never {
  process.stderr.write(`[smoke-packaged-app] ${message}\n`)
  process.exit(1)
}

function parsePositiveInteger(value: string | undefined, label: string, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(`${label} must be a positive integer`)
  return parsed
}

function parseArgs(argv: string[]): SmokeOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const [key, inlineValue] = argument.slice(2).split('=', 2)
    const value = inlineValue ?? argv[index + 1]
    if (!value || value.startsWith('--')) fail(`--${key} requires a value`)
    values.set(key, value)
    if (inlineValue === undefined) index += 1
  }

  const target = values.get('target')
  if (target !== 'mac' && target !== 'win' && target !== 'linux') {
    fail('--target must be mac, win, or linux')
  }
  const appDir = values.get('app-dir')
  if (!appDir) fail('--app-dir is required')
  const output = values.get('output') ?? null
  return {
    target,
    appDir: resolve(appDir),
    output: output ? resolve(output) : null,
    iterations: parsePositiveInteger(values.get('iterations'), '--iterations', 1),
    timeoutMs: parsePositiveInteger(values.get('timeout-ms'), '--timeout-ms', 60_000)
  }
}

async function executableFor(options: SmokeOptions): Promise<string> {
  const productName = 'CodeInOven'
  const candidates =
    options.target === 'mac'
      ? [join(options.appDir, `${productName}.app`, 'Contents', 'MacOS', productName)]
      : options.target === 'win'
        ? [join(options.appDir, `${productName}.exe`)]
        : [join(options.appDir, 'codeinoven'), join(options.appDir, productName)]
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next platform-specific packaged executable name.
    }
  }
  fail(`packaged executable not found under ${options.appDir}`)
}

function boundedAppend(current: string, chunk: Buffer): string {
  const next = current + chunk.toString('utf8')
  return next.length > 64_000 ? next.slice(-64_000) : next
}

function phaseTime(proof: SmokeProof, phase: StartupPhase, iteration: number): number {
  const record = proof.startup.phases.find((candidate) => candidate.phase === phase)
  if (!record || !Number.isFinite(record.atMs)) {
    fail(`iteration ${iteration} never reached ${phase}`)
  }
  return record.atMs
}

async function runIteration(
  executable: string,
  options: SmokeOptions,
  iteration: number
): Promise<IterationResult> {
  const runRoot = await mkdtemp(join(tmpdir(), `codeinoven-packaged-smoke-${iteration}-`))
  const proofPath = join(runRoot, 'startup-proof.json')
  let stdout = ''
  let stderr = ''
  try {
    const sandboxFlag = options.target === 'linux' ? '--no-sandbox' : null
    const child = spawn(
      executable,
      [
        `--user-data-dir=${join(runRoot, 'chromium')}`,
        '--enable-logging=stderr',
        ...(sandboxFlag ? [sandboxFlag] : [])
      ],
      {
        cwd: options.appDir,
        env: {
          ...process.env,
          ELECTRON_ENABLE_LOGGING: '1',
          CODEINOVEN_CONFIG_ROOT: join(runRoot, 'config'),
          [PACKAGED_SMOKE_OUTPUT_ENV]: proofPath
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk)
    })

    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, rejectExit) => {
        child.once('error', rejectExit)
        child.once('exit', (code, signal) => resolveExit({ code, signal }))
      }
    )
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<never>((_, rejectTimeout) => {
      timer = setTimeout(() => {
        child.kill('SIGTERM')
        rejectTimeout(
          new Error(
            `iteration ${iteration} timed out after ${options.timeoutMs}ms\n` +
              `stdout:\n${stdout}\nstderr:\n${stderr}`
          )
        )
      }, options.timeoutMs)
    })
    const outcome = await Promise.race([exit, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    if (outcome.code !== 0) {
      fail(
        `iteration ${iteration} exited with code ${outcome.code} / signal ${outcome.signal ?? 'none'}\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`
      )
    }

    let proofText: string
    try {
      proofText = await readFile(proofPath, 'utf8')
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      fail(
        `iteration ${iteration} exited cleanly without a startup proof: ${reason}\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`
      )
    }
    const proof = JSON.parse(proofText) as SmokeProof
    if (proof.schemaVersion !== 1 || !Array.isArray(proof.startup?.phases)) {
      fail(`iteration ${iteration} produced an invalid startup proof`)
    }
    const requiredPhases = new Set([
      'nativeSplash:active',
      'splash:visualReady',
      'renderer:documentLoaded',
      'window:visualReady',
      'renderer:hydrated',
      'features:ready',
      'workspace:ready'
    ])
    for (const phase of proof.startup.phases) requiredPhases.delete(phase.phase)
    if (requiredPhases.size > 0) {
      fail(
        `iteration ${iteration} did not prove required startup phases: ${[...requiredPhases].join(', ')}`
      )
    }
    const splashVisualReadyMs = phaseTime(proof, 'splash:visualReady', iteration)
    const documentLoadedMs = phaseTime(proof, 'renderer:documentLoaded', iteration)
    const featuresReadyMs = phaseTime(proof, 'features:ready', iteration)
    const visualReadyMs = phaseTime(proof, 'window:visualReady', iteration)
    const workspaceReadyMs = phaseTime(proof, 'workspace:ready', iteration)
    return {
      iteration,
      documentLoadedMs,
      featuresReadyMs,
      proofReadyMs: Math.max(documentLoadedMs, visualReadyMs, workspaceReadyMs),
      splashVisualReadyMs,
      visualReadyMs,
      workspaceReadyMs,
      startup: proof.startup
    }
  } finally {
    await rm(runRoot, { recursive: true, force: true })
  }
}

function percentile(sorted: number[], ratio: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function summarize(values: number[]): { min: number; median: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    min: sorted[0]!,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!
  }
}

async function writeOutput(output: string, value: unknown): Promise<void> {
  await mkdir(dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, output)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const executable = await executableFor(options)
  const results: IterationResult[] = []
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    results.push(await runIteration(executable, options, iteration))
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: options.target,
    executable: basename(executable),
    iterations: results.length,
    splashVisualReadyMs: summarize(results.map((result) => result.splashVisualReadyMs)),
    visualReadyMs: summarize(results.map((result) => result.visualReadyMs)),
    documentLoadedMs: summarize(results.map((result) => result.documentLoadedMs)),
    featuresReadyMs: summarize(results.map((result) => result.featuresReadyMs)),
    workspaceReadyMs: summarize(results.map((result) => result.workspaceReadyMs)),
    proofReadyMs: summarize(results.map((result) => result.proofReadyMs)),
    results
  }
  if (options.output) await writeOutput(options.output, report)
  process.stdout.write(`[smoke-packaged-app] PASS ${JSON.stringify(report.proofReadyMs)}\n`)
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
})
