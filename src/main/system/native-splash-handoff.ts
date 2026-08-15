/// <reference types="node" />

import { createConnection } from 'node:net'
import { Logger } from './logger'

const NATIVE_SPLASH_ENDPOINT_ENV = 'CODEINOVEN_NATIVE_SPLASH_ENDPOINT'
const HANDOFF_TIMEOUT_MS = 1_000

/** Whether this Electron process was started through the native launcher. */
export function hasNativeSplashHandoff(): boolean {
  return Boolean(process.env[NATIVE_SPLASH_ENDPOINT_ENV])
}

/**
 * Release the dependency-free launcher placeholder after Electron has painted
 * its own splash. Direct Electron launches (development, tests, and diagnostic
 * invocation) have no endpoint and therefore remain a no-op.
 */
export function signalNativeSplashReady(): void {
  const endpoint = process.env[NATIVE_SPLASH_ENDPOINT_ENV]
  delete process.env[NATIVE_SPLASH_ENDPOINT_ENV]
  if (!endpoint) return

  const socket = createConnection(endpoint)
  const timeout = setTimeout(() => socket.destroy(), HANDOFF_TIMEOUT_MS)
  timeout.unref()
  socket.unref()
  socket.once('connect', () => socket.end('ready'))
  socket.once('error', (error) => {
    clearTimeout(timeout)
    Logger.error('Native splash handoff failed', error)
  })
  socket.once('close', () => clearTimeout(timeout))
}
