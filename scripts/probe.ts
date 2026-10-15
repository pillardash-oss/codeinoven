/**
 * Probe runner: start an isolated app instance, prove it booted, drive it, and
 * put it away again.
 *
 * Why this exists beside `dev-probe`: a bare `bun run dev:probe` runs until its
 * window closes, so from an agent shell it needs a timeout tool to be usable at
 * all and it cannot tell "still starting" from "wedged". macOS ships no
 * `timeout(1)`, and a probe launched by hand lands on one shared default root, so
 * two agents probing at once share a data root and a log directory, and one of
 * them cleaning up can delete the other's evidence.
 *
 * Every run of this runner therefore gets:
 *   - its own run directory and data root, named for the time and the pid, so no
 *     two runs can collide, and cleanup can only ever touch its own files;
 *   - a readiness signal instead of a sleep: the boot marker the app writes once
 *     the renderer is interactive and the feature graph is up;
 *   - a scoped teardown that signals, waits, escalates, and then proves that no
 *     process of this run survived;
 *   - a verdict: PASS or FAIL with the evidence that decided it, plus the log
 *     tails, and an exit code a script (or an agent) can branch on.
 *
 * Usage (from the project root):
 *   bun run probe --name boot
 *   bun run probe --name residency --background --close-window --expect-exit 30000
 *   bun run probe --name park --background --close-window --expect-alive 20000
 *   bun run probe --name manual --keep
 *   bun run probe --name browser --debug-port 9333 --exec './scenario.sh'
 *
 * Options:
 *   --name <slug>        Label for this run's directory (default: probe)
 *   --root <path>        Reuse a root this runner created before. Must be under
 *                        .cio/tmp/probes/, so a run can never be pointed at the
 *                        user's real data or at another tool's probe root.
 *   --background         Seed backgroundMode=always in a fresh root and leave
 *                        background registration ON, so the park/quit residency
 *                        path is really exercised. This adds a menu bar icon for
 *                        the life of the run: expect it, and expect it to go.
 *   --debug-port <n>     Expose a DevTools (CDP) endpoint on this port. Also
 *                        exported to --exec as PROBE_CDP_URL.
 *   --wait-ready <ms>    Readiness budget (default: 180000)
 *   --timeout <ms>       Hard bound for the whole run (default: 300000)
 *   --close-window       Scenario: close the primary window over CDP, so the app
 *                        makes its own park-or-quit decision
 *   --expect-exit <ms>   Assert the app exits on its own within this window
 *   --expect-alive <ms>  Assert the app is still running after this long
 *   --exec <command>     Scenario: run this shell command once the app is ready
 *   --keep               Leave the probe running and print how to stop it
 *   --help
 *   --                   Everything after this reaches the dev server/Electron
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
/** This runner's own namespace: roots and run directories never leave it. */
const probesRoot = join(projectRoot, '.cio', 'tmp', 'probes')
const rootEnv = 'CODEINOVEN_PROBE_ROOT'
const noBackgroundEnv = 'CODEINOVEN_NO_BACKGROUND'
const configRootEnv = 'CODEINOVEN_CONFIG_ROOT'
const rendererPortEnv = 'CODEINOVEN_RENDERER_PORT'

interface ProbeOptions {
  name: string
  root: string | null
  background: boolean
  debugPort: number | null
  waitReadyMs: number
  timeoutMs: number
  closeWindow: boolean
  expectExitMs: number | null
  expectAliveMs: number | null
  exec: string | null
  keep: boolean
  passthrough: string[]
}

function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

function fail(message: string): never {
  process.stderr.write(`\n${message}\n`)
  process.exit(1)
}

function parseInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${flag} needs a positive whole number of milliseconds (received "${value ?? ''}")`)
  }
  return parsed
}

function parseOptions(argv: string[]): ProbeOptions {
  const options: ProbeOptions = {
    name: 'probe',
    root: null,
    background: false,
    debugPort: null,
    waitReadyMs: 180_000,
    timeoutMs: 300_000,
    closeWindow: false,
    expectExitMs: null,
    expectAliveMs: null,
    exec: null,
    keep: false,
    passthrough: []
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = (): string => {
      index += 1
      const value = argv[index]
      if (value === undefined) fail(`${arg} needs a value`)
      return value
    }
    switch (arg) {
      case '--':
        options.passthrough = argv.slice(index + 1)
        index = argv.length
        break
      case '--name':
        options.name = next().replace(/[^a-zA-Z0-9._-]/g, '-')
        break
      case '--root':
        options.root = resolve(next())
        break
      case '--background':
        options.background = true
        break
      case '--debug-port':
        options.debugPort = parseInteger(next(), '--debug-port')
        break
      case '--wait-ready':
        options.waitReadyMs = parseInteger(next(), '--wait-ready')
        break
      case '--timeout':
        options.timeoutMs = parseInteger(next(), '--timeout')
        break
      case '--close-window':
        options.closeWindow = true
        break
      case '--expect-exit':
        options.expectExitMs = parseInteger(next(), '--expect-exit')
        break
      case '--expect-alive':
        options.expectAliveMs = parseInteger(next(), '--expect-alive')
        break
      case '--exec':
        options.exec = next()
        break
      case '--keep':
        options.keep = true
        break
      case '--help':
      case '-h':
        writeDocumentation()
        process.exit(0)
        break
      default:
        if (arg.startsWith('--')) fail(`Unknown option ${arg}. Use --help for the full list.`)
        options.passthrough.push(arg)
        break
    }
  }
  if (options.expectExitMs !== null && options.expectAliveMs !== null) {
    fail('--expect-exit and --expect-alive contradict each other; pick one')
  }
  return options
}

function writeDocumentation(): void {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const start = source.indexOf(' * Probe runner:')
  const end = source.indexOf(' */')
  write(start === -1 || end === -1 ? 'See the header of scripts/probe.ts' : source.slice(start, end))
}

/**
 * Refuse a root this runner does not own.
 *
 * The point of a probe is isolation: it must never be pointed at the user's real
 * data root, and it must never reuse a root belonging to another tool or another
 * agent's run, because cleanup then deletes someone else's evidence. Keeping
 * every root under this runner's own namespace enforces both at once.
 */
function assertIsolatedRoot(requested: string): void {
  const namespace = relative(probesRoot, requested)
  if (namespace === '' || namespace.startsWith('..') || isAbsolute(namespace)) {
    fail(
      `--root must be inside ${relative(projectRoot, probesRoot)} so a probe can never ` +
        `touch real app data or another tool's probe root (received ${requested})`
    )
  }
}

/** A root on one host, so no two runs can collide. */
function mintRendererPort(): Promise<number> {
  const probe = createServer()
  return new Promise<number>((resolvePort, rejectPort) => {
    probe.once('error', rejectPort)
    probe.listen({ port: 0, host: '0.0.0.0' }, () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        rejectPort(new Error('the operating system named no port'))
        return
      }
      probe.close(() => resolvePort(address.port))
    })
  })
}

/**
 * Seed the mode the residency path needs, without touching an existing config.
 *
 * `backgroundMode` defaults to `off`, and a probe that opted out of background
 * registration can never park, so there would be nothing to observe. The write
 * is a merge: a reused root keeps everything else it learned.
 */
function seedBackgroundMode(root: string): void {
  const configPath = join(root, 'config.json')
  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>
    } catch (error) {
      fail(`Could not read ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (config.backgroundMode === 'always') return
  config.backgroundMode = 'always'
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
}

function dateDirectories(logsDir: string): string[] {
  if (!existsSync(logsDir)) return []
  return readdirSync(logsDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .slice(-2)
}

/** Byte offsets of every main log at launch, so only new text can signal a boot. */
function baselineLogSizes(root: string): Map<string, number> {
  const baseline = new Map<string, number>()
  const logsDir = join(root, 'logs')
  for (const date of dateDirectories(logsDir)) {
    const path = join(logsDir, date, 'main.jsonl')
    if (existsSync(path)) baseline.set(path, statSync(path).size)
  }
  return baseline
}

/** The boot marker: the app's own record that a launch finished starting. */
function findBootMarker(root: string, baseline: Map<string, number>): string | null {
  const logsDir = join(root, 'logs')
  for (const date of dateDirectories(logsDir)) {
    const path = join(logsDir, date, 'main.jsonl')
    if (!existsSync(path)) continue
    const offset = baseline.get(path) ?? 0
    const text = readFileSync(path, 'utf8').slice(offset)
    // `startup phases` is emitted only once the renderer reported itself ready,
    // the document had loaded, and the first paint had happened.
    if (text.includes('startup phases') && text.includes('workspace:ready')) {
      return `${date}/main.jsonl`
    }
  }
  return null
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((done) => setTimeout(done, ms))
}

interface CdpTarget {
  type?: string
  url?: string
  webSocketDebuggerUrl?: string
}

/** Close the primary window over CDP, so the app decides park or quit itself. */
async function closePrimaryWindow(debugPort: number): Promise<{ ok: boolean; detail: string }> {
  let targets: CdpTarget[]
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
    targets = (await response.json()) as CdpTarget[]
  } catch (error) {
    return { ok: false, detail: `CDP was not reachable: ${error instanceof Error ? error.message : String(error)}` }
  }
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  const appWindow = pages.find((target) => !(target.url ?? '').includes('devtools')) ?? pages[0]
  if (!appWindow?.webSocketDebuggerUrl) return { ok: false, detail: 'no page target is attached' }
  const socket = new WebSocket(appWindow.webSocketDebuggerUrl)
  try {
    await new Promise<void>((open, error) => {
      socket.onopen = () => open()
      socket.onerror = () => error(new Error('the DevTools socket refused the connection'))
    })
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: 'window.close()', awaitPromise: false }
      })
    )
    await sleep(500)
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    socket.close()
  }
  return { ok: true, detail: 'window.close() was delivered to the primary window' }
}

/** Run the shell scenario with the probes coordinates in its environment. */
async function runScenario(
  command: string,
  env: Record<string, string>
): Promise<{ code: number | null; output: string }> {
  const child = spawn(command, { shell: true, cwd: projectRoot, env: { ...process.env, ...env } })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const code = await new Promise<number | null>((done) => child.on('exit', (exitCode) => done(exitCode)))
  return { code, output }
}

/** The lines this run added to the app's error log, if any. */
function errorLogLines(root: string, baseline: Map<string, number>): string[] {
  const logsDir = join(root, 'logs')
  const lines: string[] = []
  for (const date of dateDirectories(logsDir)) {
    const path = join(logsDir, date, 'error.log')
    if (!existsSync(path)) continue
    const offset = baseline.get(path) ?? 0
    for (const line of readFileSync(path, 'utf8').slice(offset).split('\n')) {
      if (line.trim() !== '') lines.push(line.trim())
    }
  }
  return lines
}

function baselineLogSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

/** Kill anything left holding this run's root, and prove nothing did. */
async function ensureNoSurvivors(root: string, child: ChildProcess): Promise<string[]> {
  const survivors: string[] = []
  const list = (): string[] => {
    const result = Bun.spawnSync(['pgrep', '-f', root])
    return result.stdout.toString().split('\n').filter((line) => line.trim() !== '')
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await sleep(500)
  }
  let remaining = list()
  if (remaining.length > 0) {
    Bun.spawnSync(['pkill', '-TERM', '-f', root])
    await sleep(1000)
    remaining = list()
  }
  if (remaining.length > 0) {
    Bun.spawnSync(['pkill', '-KILL', '-f', root])
    await sleep(500)
    remaining = list()
  }
  for (const pid of remaining) survivors.push(pid.trim())
  return survivors
}

const options = parseOptions(Bun.argv.slice(2))
if (options.root !== null) assertIsolatedRoot(options.root)

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const runId = `${options.name}-${stamp}-${process.pid}`
const runDir = join(probesRoot, runId)
const root = options.root ?? join(runDir, 'root')
mkdirSync(root, { recursive: true })
mkdirSync(runDir, { recursive: true })

const consoleLogPath = join(runDir, 'console.log')
const logStream = createWriteStream(consoleLogPath, { flags: 'a' })

if (options.background) seedBackgroundMode(root)

const rendererPort = await mintRendererPort()
const baseline = baselineLogSizes(root)
baseline.set(join(root, 'logs', 'error.log'), baselineLogSize(join(root, 'logs', 'error.log')))

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  [configRootEnv]: root,
  // Set after the inherited environment on purpose: an inherited value names the
  // running dev app's port, which is the collision a minted port exists to avoid.
  [rendererPortEnv]: String(rendererPort),
  [rootEnv]: root
}
// CodeInOven exports this to the agents it spawns, and an agent shell is exactly
// where a probe is started. Inherited, it makes the Electron binary run as plain
// Node and the main process dies on its first `electron` import.
delete environment.ELECTRON_RUN_AS_NODE
if (options.background) delete environment[noBackgroundEnv]
else environment[noBackgroundEnv] = '1'

write(`Probe run:      ${relative(projectRoot, runDir)}`)
write(`Probe root:     ${root}`)
write(`Renderer port:  ${rendererPort}`)
write(`Background:     ${options.background ? 'registered (menu bar icon for this run)' : 'off (plain window)'}`)
if (options.debugPort !== null) write(`CDP port:       ${options.debugPort}`)

const devArgs = ['run', 'dev']
if (options.debugPort !== null) devArgs.push(`--remote-debugging-port=${options.debugPort}`)
devArgs.push(...options.passthrough)

const child = spawn('bun', devArgs, { cwd: projectRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout?.on('data', (chunk: Buffer) => logStream.write(chunk))
child.stderr?.on('data', (chunk: Buffer) => logStream.write(chunk))

let exited = false
let exitDetail = ''
child.on('exit', (code, signal) => {
  exited = true
  exitDetail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
})

const scenarioEnv: Record<string, string> = {
  PROBE_ROOT: root,
  PROBE_RUN_DIR: runDir,
  PROBE_RENDERER_PORT: String(rendererPort),
  PROBE_CONSOLE_LOG: consoleLogPath
}
if (options.debugPort !== null) scenarioEnv.PROBE_CDP_URL = `http://127.0.0.1:${options.debugPort}`

/** The verdict, assembled as the run goes so a timeout can still report it. */
const findings: string[] = []
let failed = false
const note = (line: string, isFailure = false): void => {
  findings.push(`${isFailure ? 'FAIL' : 'ok  '}  ${line}`)
  if (isFailure) failed = true
}

const hardStop = setTimeout(() => {
  note(`the run hit its ${options.timeoutMs} ms bound`, true)
  void finish()
}, options.timeoutMs)
hardStop.unref?.()

async function finish(): Promise<void> {
  clearTimeout(hardStop)
  if (options.keep) {
    write(`\nKeeping the probe alive. Stop it with: pkill -f ${root}`)
    write(`Console log: ${relative(projectRoot, consoleLogPath)}`)
    logStream.end()
    process.exit(failed ? 1 : 0)
  }
  const survivors = await ensureNoSurvivors(root, child)
  const errors = errorLogLines(root, baseline)
  logStream.end()
  write(`\n${findings.map((line) => `  ${line}`).join('\n')}`)
  if (errors.length > 0) {
    write(`\nApp error log for this run (${errors.length} line(s)):`)
    for (const line of errors.slice(0, 12)) write(`  ${line}`)
  }
  if (survivors.length > 0) {
    write(`\nSURVIVORS still holding this root: ${survivors.join(', ')}`)
    process.exit(1)
  }
  write(`\nNo process of this run survived.`)
  write(`Run directory: ${relative(projectRoot, runDir)}`)
  process.exit(failed ? 1 : 0)
}

const readyDeadline = Date.now() + options.waitReadyMs
write(`Waiting for the boot marker (up to ${options.waitReadyMs} ms)...`)
let ready = false
while (Date.now() < readyDeadline) {
  const marker = findBootMarker(root, baseline)
  if (marker !== null) {
    ready = true
    note(`booted and interactive (marker in logs/${marker})`)
    break
  }
  if (exited) {
    note(`the app stopped before it became interactive (${exitDetail})`, true)
    break
  }
  await sleep(500)
}
if (!ready && !failed) note(`the app never reported a finished boot within ${options.waitReadyMs} ms`, true)

if (ready && !failed) {
  if (options.exec !== null) {
    const scenario = await runScenario(options.exec, scenarioEnv)
    const ok = scenario.code === 0
    note(`scenario exited ${String(scenario.code)}${ok ? '' : ' (non-zero)'}`, !ok)
    if (scenario.output.trim() !== '') {
      write('\nScenario output:')
      for (const line of scenario.output.trim().split('\n').slice(-30)) write(`  ${line}`)
    }
  }
  if (options.closeWindow && options.debugPort === null) {
    note('--close-window needs --debug-port so the window can be driven', true)
  } else if (options.closeWindow) {
    const closed = await closePrimaryWindow(options.debugPort ?? 0)
    note(`close-window: ${closed.detail}`, !closed.ok)
  }
  if (options.expectExitMs !== null) {
    const deadline = Date.now() + options.expectExitMs
    while (Date.now() < deadline && !exited) await sleep(250)
    note(
      exited
        ? `the app exited on its own (${exitDetail})`
        : `the app was still running after ${options.expectExitMs} ms, so it parked`,
      !exited
    )
  }
  if (options.expectAliveMs !== null) {
    await sleep(options.expectAliveMs)
    note(
      exited
        ? `the app exited inside ${options.expectAliveMs} ms, which it was not supposed to (${exitDetail})`
        : `the app was still running after ${options.expectAliveMs} ms, as expected`,
      exited
    )
  }
}

await finish()
