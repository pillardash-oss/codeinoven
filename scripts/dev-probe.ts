/**
 * Start a probe instance: a second app to look at behaviour without touching
 * the session already running.
 *
 * A probe gets its own data root, so its SQLite database, threads, logs, and
 * Assignment API port are separate from the real app's, and it opts out of
 * background registration, so it adds no menu bar icon, registers no login
 * item, and quits for real when its window closes. The user keeps exactly one
 * menu bar icon.
 *
 *   bun run dev:probe                            data root: .cio/tmp/probe
 *   bun run dev:probe -- --inspect=9229          extra args reach electron-vite
 *   CODEINOVEN_PROBE_ROOT=/abs/root bun run dev:probe
 *
 * The launch goes through `bun run dev` on purpose, so a probe runs the same
 * `predev` preparation (Electron binary check, speech workers, branding) as a
 * normal dev start instead of a subtly different one.
 *
 * Delete `.cio/tmp/probe` to probe a first run from an empty root.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROBE_ROOT_ENV = 'CODEINOVEN_PROBE_ROOT'

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const requestedRoot = process.env[PROBE_ROOT_ENV]?.trim()
// The app ignores a relative data root, so accepting one here would silently
// probe the user's real data instead of an isolated copy.
if (requestedRoot && !isAbsolute(requestedRoot)) {
  fail(`${PROBE_ROOT_ENV} must be an absolute path.`)
}
const probeRoot = requestedRoot ? resolve(requestedRoot) : join(projectRoot, '.cio', 'tmp', 'probe')

mkdirSync(probeRoot, { recursive: true })
process.stdout.write(
  [
    `Probe data root: ${probeRoot}`,
    'Background registration is off: no menu bar icon, no login item, and closing the window quits.',
    ''
  ].join('\n')
)

const child = spawn('bun', ['run', 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: projectRoot,
  env: {
    ...process.env,
    CODEINOVEN_CONFIG_ROOT: probeRoot,
    CODEINOVEN_NO_BACKGROUND: '1'
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => fail(`Could not start the dev server: ${error.message}`))
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})
