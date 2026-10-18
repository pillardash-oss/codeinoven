/** Relaunch the dev toolchain after Electron and its old Vite parent exit. */
import { spawn } from 'node:child_process'
import { mkdir, open } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProcessEnvironment } from '../src/main/drivers/cli-environment'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const renderer = new URL(process.argv[2] ?? '')
if (
  !['http:', 'https:'].includes(renderer.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(renderer.hostname)
) {
  throw new Error('Development restart requires a local renderer URL')
}
const port = Number(renderer.port || (renderer.protocol === 'https:' ? 443 : 80))

function rendererIsListening(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: renderer.hostname.replace(/^\[|\]$/g, ''), port })
    const finish = (listening: boolean): void => {
      socket.destroy()
      resolve(listening)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(true))
  })
}

// The old electron-vite parent exits on its Electron child's close event.
// Relaunch may win that race, so never start a second server on its port.
const deadline = Date.now() + 10_000
while (await rendererIsListening()) {
  if (Date.now() >= deadline) throw new Error('The previous renderer server did not close')
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
}

const env = buildProcessEnvironment(
  { ...process.env, ELECTRON_RUN_AS_NODE: undefined, ELECTRON_RENDERER_URL: undefined },
  process.platform,
  false
)
// Preserve a probe's data root, background opt-out and exact renderer origin.
env['CODEINOVEN_RENDERER_PORT'] = String(port)

const logDirectory = join(root, '.cio', 'tmp', 'development-restart')
await mkdir(logDirectory, { recursive: true })
const log = await open(join(logDirectory, 'runner.log'), 'a')
try {
  // The already-prepared checkout needs the same local dev CLI, not another
  // installation or a second run of branding/native dependency preparation.
  const child = spawn(
    process.execPath,
    [join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev'],
    { cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd] }
  )
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
} finally {
  await log.close()
}
