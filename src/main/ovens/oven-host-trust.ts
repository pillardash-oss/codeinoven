/// <reference types="electron-vite/node" />
import { BrowserWindow, utilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { appRendererNavigationTargets, trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { sendToRenderer } from '../ipc/renderer-delivery'
import type { OvenSshInvocation } from './oven-ssh'
import hostTrustProcessPath from './oven-host-trust-process.ts?modulePath'

interface PendingPrompt {
  senderId: number
  settle(approved: boolean): void
}
const pendingPrompts = new Map<string, PendingPrompt>()
let tail: Promise<unknown> = Promise.resolve()

export function registerOvenHostTrustIpc(): void {
  ipcMain.handle('oven:hostTrust:respond', (event, requestId: unknown, approved: unknown) => {
    if (typeof requestId !== 'string' || typeof approved !== 'boolean')
      throw new Error('Invalid SSH host verification response.')
    const pending = pendingPrompts.get(requestId)
    if (pending?.senderId === event.sender.id) pending.settle(approved)
  })
}

/** Ask through the global canonical confirmation, regardless of the active Oven surface. */
async function confirmHost(prompt: string, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted()
  const target = appRendererNavigationTargets()[0]?.split(/[?#]/u)[0].replace(/\/$/u, '')
  const windows = BrowserWindow.getAllWindows().filter(
    (candidate) =>
      !candidate.isDestroyed() &&
      !candidate.webContents.isDestroyed() &&
      candidate.webContents.getURL().split(/[?#]/u)[0].replace(/\/$/u, '') === target
  )
  const focused = BrowserWindow.getFocusedWindow()
  const window = windows.find((candidate) => candidate === focused) ?? windows[0]
  if (!window || window.isDestroyed()) return false
  const requestId = randomUUID()
  return new Promise<boolean>((resolve) => {
    const settle = (approved: boolean): void => {
      if (!pendingPrompts.delete(requestId)) return
      signal.removeEventListener('abort', cancel)
      window.webContents.removeListener('destroyed', cancel)
      window.webContents.removeListener('did-start-navigation', cancel)
      sendToRenderer(window.webContents, 'oven:hostTrust:closed', requestId)
      resolve(approved)
    }
    const cancel = (): void => settle(false)
    pendingPrompts.set(requestId, { senderId: window.webContents.id, settle })
    signal.addEventListener('abort', cancel, { once: true })
    window.webContents.once('destroyed', cancel)
    window.webContents.once('did-start-navigation', cancel)
    if (!sendToRenderer(window.webContents, 'oven:hostTrust:request', { requestId, prompt }))
      cancel()
    if (signal.aborted) cancel()
  })
}

/**
 * OpenSSH owns the handshake and writes its own known_hosts file after approval.
 * A short-lived utility process keeps PTY startup and prompt parsing off main.
 */
export function verifyOvenHost(
  launch: OvenSshInvocation,
  cwd: string,
  signal?: AbortSignal
): Promise<void> {
  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(new Error('Connection timed out after 60 seconds.')),
    60_000
  )
  const lifetime = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  const result = tail
    .catch(() => undefined)
    .then(async () => {
      lifetime.throwIfAborted()
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      lifetime.throwIfAborted()
      const separator = launch.args.indexOf('--')
      if (separator < 0) throw new Error('Invalid OpenSSH host verification launch.')
      const env = Object.fromEntries(
        Object.entries(launch.env).filter(
          (entry): entry is [string, string] =>
            entry[1] !== undefined &&
            !['CIO_OVEN_KEY_PASSPHRASE', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'].includes(entry[0])
        )
      )
      env['SSH_ASKPASS_REQUIRE'] = 'never'
      env['LC_ALL'] = 'C'
      env['LANG'] = 'C'
      const worker = utilityProcess.fork(hostTrustProcessPath, [], {
        env,
        serviceName: 'Oven host verification',
        stdio: 'pipe'
      })
      const session = new AbortController()
      const sessionSignal = AbortSignal.any([lifetime, session.signal])
      let workerFinished = false
      let workerExited = false
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const finish = (error?: Error): void => {
            if (settled) return
            settled = true
            lifetime.removeEventListener('abort', abort)
            session.abort()
            if (error) reject(error)
            else resolve()
          }
          const abort = (): void =>
            finish(
              lifetime.reason instanceof Error
                ? lifetime.reason
                : new Error('Connection cancelled.')
            )
          lifetime.addEventListener('abort', abort, { once: true })
          worker.stdout?.resume()
          worker.stderr?.resume()
          worker.on('error', () => finish(new Error('OpenSSH host verification could not start.')))
          worker.on('exit', () => {
            workerExited = true
            finish(new Error('OpenSSH host verification ended unexpectedly.'))
          })
          worker.on('message', (raw: unknown) => {
            if (!raw || typeof raw !== 'object' || !('type' in raw)) return
            if (raw.type === 'done' || raw.type === 'error') workerFinished = true
            if (settled) return
            if (raw.type === 'done') finish()
            else if (raw.type === 'error')
              finish(
                new Error(
                  'message' in raw && typeof raw.message === 'string'
                    ? raw.message
                    : 'Host verification failed.'
                )
              )
            else if (raw.type === 'prompt' && 'prompt' in raw && typeof raw.prompt === 'string') {
              void confirmHost(raw.prompt, sessionSignal)
                .then((approved) => {
                  if (!settled) worker.postMessage({ type: 'answer', approved })
                })
                .catch(() => finish(new Error('Host verification cancelled.')))
            }
          })
          worker.postMessage({
            type: 'start',
            executable: launch.executable,
            cwd,
            env,
            args: [
              '-o',
              'StrictHostKeyChecking=ask',
              '-o',
              'BatchMode=no',
              '-o',
              'PreferredAuthentications=none',
              '-o',
              'NumberOfPasswordPrompts=0',
              '-o',
              'PubkeyAuthentication=no',
              '-o',
              'PasswordAuthentication=no',
              '-o',
              'KbdInteractiveAuthentication=no',
              '-o',
              'ControlMaster=no',
              '-o',
              'ControlPath=none',
              '-o',
              'ForwardAgent=no',
              '-o',
              'FingerprintHash=sha256',
              ...launch.args.slice(0, separator),
              '--',
              launch.args[separator + 1],
              'exit'
            ]
          })
          if (lifetime.aborted) abort()
        })
      } finally {
        session.abort()
        if (!workerFinished && !workerExited) {
          await new Promise<void>((resolve) => {
            const grace = setTimeout(resolve, 300)
            worker.once('message', () => {
              clearTimeout(grace)
              resolve()
            })
            worker.postMessage({ type: 'cancel' })
          })
        }
        worker.kill()
      }
    })
    .finally(() => clearTimeout(timer))
  tail = result
  return result
}
