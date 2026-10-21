/// <reference types="node" />

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { app } from 'electron'
import { APP_NAME } from '../../lib/brand'
import { Logger } from './logger'

const NATIVE_SPLASH_ENDPOINT_ENV = 'CODEINOVEN_NATIVE_SPLASH_ENDPOINT'
const HELPER_ARGUMENT = '--codeinoven-native-splash-helper'
const ENDPOINT_TIMEOUT_MS = 2_000
const HANDOFF_TIMEOUT_MS = 1_000

/**
 * The dependency-free splash window shown while Chromium builds its first
 * frame. Two launches exist:
 *
 *   - Windows and Linux start the app through the tiny supervisor, which owns
 *     the entry point and passes the handoff socket in the environment.
 *   - macOS cannot: the Electron runtime is the bundle's main executable because
 *     that process is the product the OS shows, so the app spawns the splash
 *     itself and reads the socket from the helper's first line of output.
 *
 * Either way the placeholder is only ever released once the app has painted its
 * own splash, and a helper that never gets that signal tears itself down.
 */
let endpoint: string | null = process.env[NATIVE_SPLASH_ENDPOINT_ENV] ?? null
let helperEndpoint: Promise<string | null> | null = null

/** Whether this process has (or is starting) a native splash to release. */
export function hasNativeSplashHandoff(): boolean {
  return endpoint !== null || helperEndpoint !== null
}

/**
 * Spawn the macOS splash helper. It renders the placeholder in its own process,
 * hands back a unix socket path, and exits as soon as the app connects, so no
 * part of the app's boot depends on the helper staying alive.
 */
export function startNativeSplashHelper(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  if (process.env['CODEINOVEN_DISABLE_NATIVE_SPLASH'] === '1') return
  if (endpoint !== null || helperEndpoint !== null) return
  // Contents/Helpers/<product> Splash, next to the app's own executable.
  const helperPath = resolve(dirname(process.execPath), '..', 'Helpers', `${APP_NAME} Splash`)
  if (!existsSync(helperPath)) return
  let child: ChildProcess
  try {
    // File descriptor 1 is the endpoint pipe the helper writes its socket path
    // to, so the handoff never depends on a shared temporary path.
    child = spawn(helperPath, [HELPER_ARGUMENT, '1'], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (error: unknown) {
    Logger.error('Native splash helper could not start:', error)
    return
  }
  child.once('error', (error: Error) => {
    Logger.error('Native splash helper failed:', error)
  })
  // The helper must never keep the app alive or delay its exit.
  child.unref()
  child.stdout?.setEncoding('utf8')
  helperEndpoint = readEndpoint(child)
}

/** Resolve the endpoint the helper reports, or null when it never does. */
function readEndpoint(child: ChildProcess): Promise<string | null> {
  return new Promise((settle) => {
    let buffer = ''
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.removeListener('data', onData)
      settle(value)
    }
    const onData = (chunk: string): void => {
      buffer += chunk
      // The native side writes a NUL-terminated path and no newline, so either
      // terminator ends the read.
      const end = buffer.search(/[\0\n]/u)
      if (end >= 0) finish(buffer.slice(0, end).trim() || null)
    }
    const timer = setTimeout(() => finish(null), ENDPOINT_TIMEOUT_MS)
    timer.unref()
    child.stdout?.on('data', onData)
    child.once('close', () => finish(null))
  })
}

/**
 * Release the dependency-free placeholder after Electron has painted its own
 * splash. Direct Electron launches (development, tests, and diagnostic
 * invocation) have no helper and therefore remain a no-op.
 */
export function signalNativeSplashReady(): void {
  const pending = endpoint !== null ? Promise.resolve(endpoint) : helperEndpoint
  endpoint = null
  helperEndpoint = null
  delete process.env[NATIVE_SPLASH_ENDPOINT_ENV]
  if (pending === null) return
  void pending.then((value) => {
    if (value === null) return
    releaseEndpoint(value)
  })
}

function releaseEndpoint(value: string): void {
  const socket = createConnection(value)
  const timeout = setTimeout(() => socket.destroy(), HANDOFF_TIMEOUT_MS)
  timeout.unref()
  socket.unref()
  socket.once('connect', () => socket.end('ready'))
  socket.once('error', (error: Error) => {
    clearTimeout(timeout)
    Logger.error('Native splash handoff failed', error)
  })
  socket.once('close', () => clearTimeout(timeout))
}
