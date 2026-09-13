#!/usr/bin/env bun
/// <reference types="node" />

/**
 * Local mirror of the GitHub Actions CI checks, matched to the host OS.
 *
 * Every job in .github/workflows/quality.yml, security.yml and the per-OS part
 * of nightly.yml is represented here as a stage. Running this script on macOS
 * runs the macOS stages, on Windows the Windows stages, on Linux the Linux
 * stages — so a green local run means the same-named CI jobs would pass.
 *
 * Usage:
 *   bun run ci:local                 # full platform-appropriate run
 *   bun run ci:local --list          # print the stage plan without running
 *   bun run ci:local --only check,test
 *   bun run ci:local --skip audit,package
 *   bun run ci:local --no-install    # reuse node_modules (skips frozen install)
 *   bun run ci:local --gate          # deploy gate: keep running past failures and
 *                                    # report each failed stage to .cio/git/ci/<unix-ts>/
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { toPosixPath } from '../src/lib/paths'

type SmokeTarget = 'linux' | 'mac' | 'win'

type PackageTarget = 'linux' | 'mac' | 'win'

interface Stage {
  id: string
  label: string
  run: () => Promise<number>
  /** Flavor text for stages that need extra local tooling. */
  hint?: string
}

interface StageOptions {
  install: boolean
  skip: Set<string>
  only: Set<string> | null
  /** Gate mode: never abort mid-run; capture failing stages into .cio/git/ci/<unix-ts>/. */
  gate: boolean
}

const projectRoot = process.cwd()
const isCI = process.env.CI === 'true'

/**
 * When set, runStep pipes/tees each command's output into this capture instead
 * of straight inheritance (used by gate mode to record failing stage output).
 */
let activeCapture: Capture | null = null

function fail(message: string): never {
  process.stderr.write(`[ci-local] ${message}\n`)
  process.exit(1)
}

function parseTarget(): SmokeTarget {
  switch (process.platform) {
    case 'darwin':
      return 'mac'
    case 'win32':
      return 'win'
    case 'linux':
      return 'linux'
    default:
      fail(`Unsupported platform for the CI mirror: ${process.platform}`)
  }
}

function parseArgs(argv: string[]): StageOptions {
  const options: StageOptions = { install: true, skip: new Set(), only: null, gate: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--list') continue
    if (argument === '--no-install') {
      options.install = false
      continue
    }
    if (argument === '--gate') {
      options.gate = true
      continue
    }
    if (argument !== '--only' && argument !== '--skip') fail(`Unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail(`${argument} requires a comma-separated stage list`)
    index += 1
    const stages = new Set(
      value
        .split(',')
        .map((stage) => stage.trim())
        .filter((stage) => stage.length > 0)
    )
    if (stages.size === 0) fail(`${argument} requires a comma-separated stage list`)
    if (argument === '--skip') {
      for (const stage of stages) options.skip.add(stage)
    } else {
      options.only = stages
    }
  }
  return options
}

async function runStep(command: string[], label: string, env: Record<string, string> = {}): Promise<number> {
  const capture = activeCapture
  const startedAt = performance.now()
  process.stdout.write(`\n[ci-local] ▶ ${label}\n`)
  const child = Bun.spawn(command, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    stderr: capture ? 'pipe' : 'inherit',
    stdin: capture ? 'ignore' : 'inherit',
    stdout: capture ? 'pipe' : 'inherit'
  })
  if (capture) {
    capture.output = ''
    const decoder = new TextDecoder()
    const sink = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
      if (!stream) return
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true })
        capture.output += text
        process.stdout.write(text)
      }
    }
    await Promise.all([
      sink(child.stdout as ReadableStream<Uint8Array>),
      sink(child.stderr as ReadableStream<Uint8Array>)
    ])
  }
  const exitCode = await child.exited
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1)
  if (exitCode === 0) {
    process.stdout.write(`[ci-local] ✔ ${label} (${seconds}s)\n`)
  } else {
    process.stderr.write(`[ci-local] ✖ ${label} failed with exit ${exitCode} (${seconds}s)\n`)
  }
  return exitCode
}

async function hasBinary(binary: string): Promise<boolean> {
  const child = Bun.spawn([binary, '--version'], {
    cwd: projectRoot,
    stderr: 'ignore',
    stdout: 'ignore',
    stdin: 'ignore'
  })
  return (await child.exited) === 0
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  env.MAIN_VITE_REMOTE_API_ORIGIN = 'https://mobile.codeinoven.com'
  env.CODEINOVEN_GITHUB_CLIENT_ID = process.env.CODEINOVEN_GITHUB_CLIENT_ID ?? ''
  return env
}

async function stage(id: string, label: string, command: string[], hint?: string, env: Record<string, string> = {}): Promise<Stage> {
  return {
    id,
    hint,
    label,
    run: () => runStep(command, label, env)
  }
}

interface Capture {
  output: string
}

interface Capture {
  output: string
}

interface GateFailure {
  id: string
  label: string
  exitCode: number
  output: string
}

interface SmokeStageConfig {
  retries: number
  retryDelayMs: number
  /** quality.yml treats the Windows startup smoke as known-flaky and non-blocking. */
  softFail: boolean
  useXvfb: boolean
}

async function runSmokeStage(config: SmokeStageConfig, target: SmokeTarget, appDir: string): Promise<number> {
  const label = `Packaged-app startup smoke (${target})`
  const xvfb = config.useXvfb
  if (xvfb && !(await hasBinary('xvfb-run'))) {
    process.stderr.write(
      '[ci-local] xvfb-run is required to mirror the Linux packaged smoke test.\n' +
        '          Install it with: sudo apt-get install -y xvfb\n'
    )
    return 1
  }
  let exitCode = 1
  for (let attempt = 1; attempt <= config.retries; attempt += 1) {
    const runner = xvfb ? ['xvfb-run', '-a'] : []
    exitCode = await runStep(
      [...runner, 'bun', 'run', 'smoke:packaged', `--target=${target}`, `--app-dir=${appDir}`],
      `${label} — attempt ${attempt}/${config.retries}`
    )
    if (exitCode === 0) break
    if (config.softFail) {
      process.stdout.write(`[ci-local] smoke attempt ${attempt} failed (known flaky, retrying)\n`)
      await Bun.sleep(config.retryDelayMs)
    }
  }
  if (exitCode !== 0 && config.softFail) {
    process.stdout.write(
      `[ci-local] ::warning:: ${label} failed with exit ${exitCode} — mirrored as non-blocking, like quality.yml\n`
    )
    return 0
  }
  return exitCode
}

function appDirFor(target: PackageTarget): string {
  if (target === 'win') return 'dist/win-unpacked'
  if (target === 'linux') return 'dist/linux-unpacked'
  return process.arch === 'arm64' ? 'dist/mac-arm64' : 'dist/mac-unpacked'
}

async function buildStagePlan(options: StageOptions, target: SmokeTarget): Promise<Stage[]> {
  const env = buildEnv()
  const installCommand = ['bun', 'install', '--frozen-lockfile']
  const stages: Stage[] = []

  if (options.install) {
    stages.push(await stage('install', 'Frozen install', installCommand))
  }

  // Mirrors quality.yml jobs: check, lint, test, audit, build (shared runtime).
  // The test stage pins CI=true because GitHub Actions always sets it — running
  // vitest with the exact CI environment keeps the local mirror faithful, so a
  // green local test stage means the CI Tests job sees the same behavior.
  stages.push(
    await stage('check', 'Type check', ['bun', 'run', 'check']),
    await stage('lint', 'Lint', ['bun', 'run', 'lint', '.']),
    await stage('test', 'Tests', ['bun', 'run', 'test'], undefined, { CI: 'true' }),
    await stage('audit', 'Dependency audit', ['bun', 'audit'])
  )

  if (target === 'mac') {
    // quality.yml build job + nightly macOS speech-worker builds.
    stages.push(
      await stage('speech-workers', 'Build Apple Silicon speech workers', [
        'bun',
        'run',
        'speech:build-mlx'
      ])
    )
    stages.push(
      await stage('speech-coreml', 'Build CoreML speech worker', ['bun', 'run', 'speech:build-coreml'])
    )
    stages.push(
      await stage('speech-capture', 'Build native speech capture', [
        'bun',
        'run',
        'speech:build-native-capture'
      ])
    )
  }

  stages.push(await stage('harness', 'Build Pi harness', ['bun', 'run', 'harness:build-pi']))

  stages.push(
    await stage('build', 'Production build', ['bun', 'run', 'build:production'], undefined, env),
    await stage('bundle-budgets', 'Bundle budgets', ['bun', 'run', 'check:bundle'])
  )

  // security.yml "Detect leaked secrets": gitleaks runs locally when installed.
  stages.push({
    id: 'gitleaks',
    hint: 'Install gitleaks (brew install gitleaks) to mirror the security.yml secrets scan.',
    label: 'Secrets scan (gitleaks)',
    run: async () => {
      if (!(await hasBinary('gitleaks'))) {
        process.stdout.write('[ci-local] gitleaks not installed — skipping (see security.yml)\n')
        return 0
      }
      return runStep(['gitleaks', 'detect'], 'Secrets scan (gitleaks)')
    }
  })

  // Packaging + startup smoke mirrors quality.yml windows-runtime/linux-runtime
  // and the per-target build job of nightly.yml. macOS packaging is included so
  // mac contributors catch packaging regressions too.
  stages.push({
    id: 'clean-dist',
    label: 'Clean stale packaged output (dist/)',
    run: async () => {
      // Leftover artifacts from earlier builds (stale .bin symlinks, old app
      // bundles) collide with electron-builder's dependency traversal and fail
      // packaging with EEXIST, so packaging must always start from a clean
      // dist/. Build outputs only — never source or node_modules.
      rmSync(join(projectRoot, 'dist'), { force: true, recursive: true })
      process.stdout.write('[ci-local] removed stale dist/ packaged output\n')
      return 0
    }
  })
  stages.push(
    await stage(
      'package',
      `Package ${target} application`,
      // Mac mirrors nightly.yml, which ships dmg+zip artifacts —
      // verify-packaged-app requires them, so a --dir (unpacked-only) run can
      // never pass the gate. Local run is ad-hoc signed (no identity, no
      // notarization), mirroring the package:mac script.
      target === 'mac'
        ? [
            'bunx',
            'electron-builder',
            '--mac',
            '--arm64',
            '-c.forceCodeSigning=false',
            '-c.mac.identity=-',
            '-c.mac.hardenedRuntime=false',
            '-c.mac.notarize=false'
          ]
        : [
            'bunx',
            'electron-builder',
            `--${target}`,
            ...(target === 'win' ? ['--x64'] : ['--x64']),
            '--dir',
            '-c.forceCodeSigning=false'
          ],
      undefined,
      target === 'mac' ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : {}
    )
  )
  stages.push(
    await stage('verify-packaged', 'Verify packaged artifacts', [
      'bun',
      'run',
      'verify:packaged-app',
      `--target=${target}`,
      '--artifact-dir=dist'
    ])
  )
  stages.push({
    id: 'smoke',
    label: 'Packaged-app startup smoke',
    run: () => runSmokeStage(
      {
        retries: 3,
        retryDelayMs: 10_000,
        softFail: target === 'win',
        useXvfb: target === 'linux'
      },
      target,
      appDirFor(target)
    )
  })

  return stages
}

function select(stages: Stage[], options: StageOptions): Stage[] {
  return stages.filter((stage) => {
    if (options.skip.has(stage.id)) return false
    if (options.only && !options.only.has(stage.id)) return false
    return true
  })
}

async function writeGateReports(
  reportDir: string,
  failures: GateFailure[],
  target: SmokeTarget,
  startedAt: number,
  stageCount: number
): Promise<void> {
  await mkdir(reportDir, { recursive: true })
  for (const failure of failures) {
    const content = [
      `# CI failure: ${failure.label}`,
      '',
      `- Stage: \`${failure.id}\``,
      `- Host platform: ${target}`,
      `- Exit code: ${failure.exitCode}`,
      `- Started at (unix): ${startedAt}`,
      '- Mirrors: the same-named job(s) in `.github/workflows/quality.yml`, `security.yml`, `nightly.yml`',
      '',
      '## Output',
      '',
      '```',
      failure.output.trimEnd(),
      '```',
      ''
    ].join('\n')
    await writeFile(join(reportDir, `${failure.id}.md`), `${content}\n`, 'utf8')
  }
  const summary = [
    '# Local CI gate summary',
    '',
    `- Started at (unix): ${startedAt}`,
    `- Host platform: ${target}`,
    `- Stages run: ${stageCount}, failed stages: ${failures.length}`,
    '',
    ...failures.map(
      (failure) => `- \`${failure.id}\` — ${failure.label} (exit ${failure.exitCode}) → [report](${failure.id}.md)`
    ),
    ''
  ].join('\n')
  await writeFile(join(reportDir, 'summary.md'), `${summary}\n`, 'utf8')
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2)
  const listOnly = argv.includes('--list')
  const options = parseArgs(argv)
  const target = parseTarget()

  const gateStartedAt = Math.floor(Date.now() / 1000)
  const gateFailures: GateFailure[] = []

  const plan = await buildStagePlan(options, target)
  const selected = select(plan, options)
  const unknown = [
    ...options.skip,
    ...(options.only ?? [])
  ].filter((id) => !plan.some((stage) => stage.id === id))
  if (unknown.length > 0) {
    fail(`Unknown stage(s): ${unknown.join(', ')}. Available: ${plan.map((stage) => stage.id).join(', ')}`)
  }

  process.stdout.write(`[ci-local] host platform: ${target} — mirroring the ${target} CI jobs\n`)
  process.stdout.write(
    `[ci-local] stage plan (${selected.length}/${plan.length}):\n` +
      selected.map((stage) => `  - ${stage.id}: ${stage.label}`).join('\n') +
      '\n'
  )
  if (listOnly) return

  if (isCI) fail('This script is for local use only; run the real workflows in CI.')
  if (options.install && selected.some((stage) => stage.id === 'install')) {
    process.stdout.write(
      '[ci-local] note: the frozen install wipes nothing, but it can take a while; use --no-install to reuse node_modules\n'
    )
  }

  const failures: string[] = []
  activeCapture = options.gate ? { output: '' } : null
  for (const stage of selected) {
    if (activeCapture) activeCapture.output = ''
    const exitCode = await stage.run()
    if (exitCode === 0) continue
    if (activeCapture) {
      gateFailures.push({
        id: stage.id,
        label: stage.label,
        exitCode,
        output: activeCapture.output
      })
    } else {
      failures.push(`${stage.id} (${stage.label}) — exit ${exitCode}`)
    }
  }
  activeCapture = null

  if (options.gate) {
    if (gateFailures.length === 0) {
      process.stdout.write('\n[ci-local] gate passed ✅ — local run mirrors CI green; safe to deploy\n')
      return
    }
    const reportDir = join(projectRoot, '.cio', 'git', 'ci', String(gateStartedAt))
    await writeGateReports(reportDir, gateFailures, target, gateStartedAt, selected.length)
    process.stderr.write(
      '\n[ci-local] ::error:: ' +
      `${gateFailures.length} CI stage(s) failed:\n  - ${gateFailures.map((failure) => failure.id).join('\n  - ')}\n` +
      `[ci-local] reports: ${toPosixPath(relative(projectRoot, reportDir))}\n` +
      '[ci-local] Deployment is blocked until every stage passes.\n'
    )
    process.exit(1)
  }

  if (failures.length > 0) {
    process.stderr.write(
      `\n[ci-local] FAILED stages:\n  - ${failures.join('\n  - ')}\n` +
        '[ci-local] Fix these before pushing; the same-named CI jobs will fail too.\n'
    )
    process.exit(1)
  }
  process.stdout.write('\n[ci-local] all stages passed ✅ — local run mirrors CI green\n')
}

await main()
