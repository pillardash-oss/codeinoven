/**
 * Starting the CIO Pi host inside Electron.
 *
 * The host is a plain Node program, so it runs as an Electron `utilityProcess`:
 * an OS-managed app helper that never shows a Dock icon, never registers a
 * standalone app, and dies with the main process. Its transport is the parent
 * port, because a utility process has no stdin, and it speaks the same newline
 * JSON the protocol defines.
 *
 * The entry is its own rollup input and lands at `out/main/pi-session-host.js`,
 * beside the main bundle in dev and inside the asar in the package. It cannot
 * be found from `__dirname` here: this module is bundled into a shared chunk
 * under `out/main/chunks/`, so the app root is what locates the entry.
 */
import { app, utilityProcess } from 'electron'
import { join } from 'node:path'
import { auditPiImageSupport } from '../drivers/pi/pi-image-support'
import { Logger } from '../system/logger'
import type { HostTransport } from './pi-host-supervisor'

/** The built host entry, beside the main bundle in dev and in the package. */
export function piHostEntryPath(): string {
  return join(app.getAppPath(), 'out/main/pi-session-host.js')
}

/** One host process, spoken to as protocol lines. */
export function spawnPiHost(): HostTransport {
  // Hosted Pi runs the app's own bundled copy, whose image pipeline depends on
  // a wasm payload the bundler does not emit. Checking it here is what turns a
  // silent "image omitted" on every attachment into a named log line; it is
  // cached, so this costs one existence check per app run.
  auditPiImageSupport(import.meta.url)
  const helper = utilityProcess.fork(piHostEntryPath(), [], { stdio: 'pipe' })
  const lineListeners: ((line: string) => void)[] = []
  const exitListeners: ((code: number | null) => void)[] = []
  let buffered = ''

  const drain = (chunk: string): void => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim()
      buffered = buffered.slice(newline + 1)
      if (line.length > 0) for (const listener of lineListeners) listener(line)
      newline = buffered.indexOf('\n')
    }
  }

  helper.stdout?.on('data', (chunk: Buffer) => drain(chunk.toString()))
  helper.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text.length > 0) Logger.dev('[pi host]', text)
  })
  // A line may arrive as one message instead of a stdout write, depending on
  // where the host flushed it, so both paths feed the same buffer.
  helper.on('message', (message: unknown) => {
    if (typeof message === 'string') drain(message)
  })
  helper.on('exit', (code: number) => {
    for (const listener of exitListeners) listener(code)
  })

  return {
    // A getter, not a frozen value: Electron assigns the pid when the utility
    // process actually starts, so reading it once at fork time reported 0 for
    // every host the rest of the app then tried to list or show.
    get pid(): number {
      return helper.pid ?? 0
    },
    send: (line) => helper.postMessage(line),
    onLine: (listener) => {
      lineListeners.push(listener)
    },
    onExit: (listener) => {
      exitListeners.push(listener)
    },
    stop: () => {
      helper.kill()
    }
  }
}
