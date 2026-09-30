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
 *   CODEINOVEN_PROBE_PORT=6200 bun run dev:probe  pin the probe's renderer port
 *
 * The launch goes through `bun run dev` on purpose, so a probe runs the same
 * `predev` preparation (Electron binary check, speech workers, branding) as a
 * normal dev start instead of a subtly different one.
 *
 * A probe runs beside the dev app and beside every other probe, not instead of
 * them, so it cannot share a renderer port with either. The dev server pins 5173
 * for the primary checkout and derives 5200-5999 for a linked worktree (see
 * `resolveRendererPort` in `electron.vite.config.ts`); a probe instead mints a
 * free port from the OS at launch and hands it over as
 * `CODEINOVEN_RENDERER_PORT`, so any number of probes can start beside `bun dev`
 * and beside each other. The port is part of the renderer origin, so a minted
 * probe starts on fresh renderer state; pin `CODEINOVEN_PROBE_PORT` when a probe
 * has to keep one origin (and therefore its persisted state) across restarts.
 *
 * Delete `.cio/tmp/probe` to probe a first run from an empty root.
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROBE_ROOT_ENV = 'CODEINOVEN_PROBE_ROOT'
/** Pins the probe's renderer port instead of minting one; sibling of the root. */
const PROBE_PORT_ENV = 'CODEINOVEN_PROBE_PORT'

/** Where a probe's renderer port came from, reported in the launch banner. */
type ProbePortSource = 'minted' | 'pinned'

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

/**
 * Mint a renderer port nobody is holding, so this probe owns one of its own.
 *
 * A probe starts beside the dev app and beside every other probe, so a shared
 * port would be a collision rather than an isolation: several agents probing at
 * once would fight over one number. Every probe therefore asks the OS for a port
 * that is free at that moment, exactly as the app's other development listeners
 * (utility gateway, preview services, the sign-in callback) already do. The
 * wildcard address is used because that is the strictest availability check, and
 * the socket is released only once the OS has named the port, before the dev
 * server binds it.
 */
async function mintRendererPort(): Promise<number> {
  const probe = createServer()
  return await new Promise<number>((resolvePort, rejectPort) => {
    probe.once('error', rejectPort)
    probe.listen({ port: 0, host: '0.0.0.0' }, () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close()
        rejectPort(new Error('the operating system named no port'))
        return
      }
      const mintedPort = address.port
      probe.close(() => resolvePort(mintedPort))
    })
  })
}

/**
 * The renderer port this probe hands to the dev server, and where it came from.
 *
 * `CODEINOVEN_PROBE_PORT` pins the port instead, for the two things a minted one
 * cannot do: name a port in advance, and keep the renderer origin (which carries
 * the renderer's persisted state) stable across restarts. The pin is validated
 * here rather than passed through, because the dev server reports a bad value
 * against `CODEINOVEN_RENDERER_PORT`, a variable the probe sets itself and the
 * caller never did.
 */
async function resolveProbeRendererPort(): Promise<{ port: number; source: ProbePortSource }> {
  const pinned = process.env[PROBE_PORT_ENV]?.trim()
  if (pinned) {
    const parsed = Number(pinned)
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      fail(`${PROBE_PORT_ENV} must be an integer between 1024 and 65535 (received "${pinned}")`)
    }
    return { port: parsed, source: 'pinned' }
  }
  try {
    return { port: await mintRendererPort(), source: 'minted' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    fail(`Could not mint a free renderer port: ${reason}`)
  }
}

const { port: probeRendererPort, source: probePortSource } = await resolveProbeRendererPort()

mkdirSync(probeRoot, { recursive: true })
process.stdout.write(
  [
    `Probe data root: ${probeRoot}`,
    `Probe renderer port: ${probeRendererPort} (${probePortSource})`,
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
    // Hand the dev server the port this probe minted (or was pinned to). It is
    // set after the inherited environment on purpose: an inherited
    // CODEINOVEN_RENDERER_PORT names the port the running dev app is on, which is
    // the collision the mint exists to avoid.
    CODEINOVEN_RENDERER_PORT: String(probeRendererPort),
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
