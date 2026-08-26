/**
 * Dev workflow for testing the remote/mobile PWA (remote.html) with live HMR.
 *
 * Runs `electron-vite dev` with the renderer dev server bound to 0.0.0.0 over
 * HTTPS (self-signed cert covering this machine's LAN IPs), so a phone on the
 * same WiFi can open the dev server directly — full HMR, no LAN-gateway
 * build/serve cycle. Pass `--tunnel` to also start an ngrok HTTP tunnel to
 * that port, for testing from a phone on a different network (cellular,
 * different WiFi) with a public HTTPS URL.
 *
 * Usage:
 *   bun scripts/dev-remote-pwa.ts             # same-WiFi only
 *   bun scripts/dev-remote-pwa.ts --tunnel    # + ngrok tunnel
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadOrCreateSelfSignedCertificate,
  detectPreferredLanIps
} from '../src/main/remote/self-signed-cert'
import { Logger } from '../src/main/system/logger'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const certDir = join(root, '.cio/tmp/remote-pwa-dev-cert')
const port = Number(process.env.REMOTE_PWA_DEV_PORT ?? 5173)
const wantsTunnel = process.argv.includes('--tunnel')

const children: ChildProcess[] = []
let shuttingDown = false

function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) child.kill('SIGTERM')
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function ngrokAvailable(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = spawn('ngrok', ['version'], { stdio: 'ignore' })
    probe.on('error', () => resolvePromise(false))
    probe.on('exit', (code) => resolvePromise(code === 0))
  })
}

async function fetchNgrokPublicUrl(): Promise<string | null> {
  try {
    const response = await fetch('http://127.0.0.1:4040/api/tunnels')
    if (!response.ok) return null
    const data = (await response.json()) as { tunnels?: Array<{ public_url?: string }> }
    return data.tunnels?.find((t) => t.public_url?.startsWith('https://'))?.public_url ?? null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  if (wantsTunnel && !(await ngrokAvailable())) {
    Logger.error(
      '[dev-remote-pwa] --tunnel was passed but `ngrok` is not on PATH. Install it (e.g. `brew install ngrok`) or drop --tunnel.'
    )
    process.exit(1)
  }

  await mkdir(certDir, { recursive: true })
  const cert = await loadOrCreateSelfSignedCertificate(certDir)
  const lanIps = detectPreferredLanIps()

  Logger.info(`[dev-remote-pwa] Self-signed cert ready for: ${cert.hosts.join(', ')}`)
  Logger.info('[dev-remote-pwa] Same-WiFi phone URL(s):')
  for (const ip of lanIps) Logger.info(`  https://${ip}:${port}/remote.html`)
  if (lanIps.length === 0) {
    Logger.info('  (no LAN IP detected — connect this machine to WiFi/Ethernet)')
  }
  Logger.info(
    '[dev-remote-pwa] The phone browser will warn about the self-signed cert — accept/continue is expected in dev.'
  )

  const devProcess = spawn('bun', ['run', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, REMOTE_PWA_DEV: '1', REMOTE_PWA_DEV_PORT: String(port) }
  })
  children.push(devProcess)
  devProcess.on('exit', (code) => shutdown(code ?? 0))

  if (wantsTunnel) {
    const ngrokProcess = spawn(
      'ngrok',
      ['http', `https://localhost:${port}`, '--log=stdout', '--log-format=logfmt'],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    )
    children.push(ngrokProcess)
    ngrokProcess.stdout?.on('data', () => {})
    ngrokProcess.on('exit', (code) => {
      if (!shuttingDown) Logger.error(`[dev-remote-pwa] ngrok exited (code ${code}).`)
    })

    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 500))
      const url = await fetchNgrokPublicUrl()
      if (url) {
        Logger.info(`[dev-remote-pwa] Different-network phone URL: ${url}/remote.html`)
        break
      }
      if (attempt === 19) {
        Logger.info(
          '[dev-remote-pwa] Could not read the ngrok public URL automatically — check http://127.0.0.1:4040 for it.'
        )
      }
    }
  }
}

void main()
