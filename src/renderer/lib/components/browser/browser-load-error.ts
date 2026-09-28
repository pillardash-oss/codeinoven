import type { Component } from 'svelte'
import {
  Ban,
  CircleAlert,
  Clock,
  FileWarning,
  Globe,
  PlugZap,
  ServerCrash,
  ShieldAlert,
  Unplug,
  WifiOff
} from '@lucide/svelte'
import type { BrowserLoadError } from '$shared/ipc-contract'

/**
 * The human answer to one failed browser load.
 *
 * Chromium reports a numbered net error and a server reports a numbered status,
 * and neither is something a user should have to read. This module is the one
 * place that turns either into a short title, a plain sentence, an icon and a
 * raw detail line, so every surface that shows a failed page agrees on the copy
 * instead of writing its own switch.
 */
export interface BrowserLoadErrorCopy {
  /** Short, plain phrase naming what failed. */
  title: string
  /** One sentence naming the site and what the user can do about it. */
  description: string
  /** Lucide icon that matches the failure. */
  icon: Component
}

/** Chromium's net errors for TLS/certificate problems span this closed range. */
const CERTIFICATE_ERROR_START = -220
const CERTIFICATE_ERROR_END = -200

/** The host of a failed address, so the copy can name the site. Empty when the
 *  address is unparseable, which the copy reads as "this page". */
export function browserLoadErrorHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** The friendly copy for a failure, with `host` naming the site it happened on. */
export function browserLoadErrorCopy(error: BrowserLoadError, host: string): BrowserLoadErrorCopy {
  if (error.kind === 'crashed') {
    return {
      icon: ServerCrash,
      title: 'This page stopped',
      description: `${host ? `${host} stopped` : 'This page stopped'} running unexpectedly. Reloading usually brings it back.`
    }
  }
  if (error.kind === 'http') return httpErrorCopy(error.code, error.description, host)
  return networkErrorCopy(error.code, host)
}

/**
 * The raw detail line under the copy, e.g. `ERR_NAME_NOT_RESOLVED (-105)` or
 * `HTTP 502`. Kept short and honest: it is what a user pastes when asking for
 * help, and it never hides the specific failure behind the friendly one.
 */
export function browserLoadErrorDetail(error: BrowserLoadError): string {
  if (error.kind === 'http') {
    return error.description ? `HTTP ${error.code} ${error.description}` : `HTTP ${error.code}`
  }
  if (error.kind === 'crashed') {
    return error.description ? `Renderer stopped: ${error.description}` : 'Renderer stopped'
  }
  return error.description
    ? `${error.description} (${error.code})`
    : `Network error (${error.code})`
}

function httpErrorCopy(code: number, statusText: string, host: string): BrowserLoadErrorCopy {
  const label = statusText ? `${code} ${statusText}` : `${code}`
  if (code === 401) {
    return {
      icon: ShieldAlert,
      title: 'Sign in required',
      description: `Sign in to reach this page${host ? ` on ${host}` : ''} (${label}).`
    }
  }
  if (code === 403) {
    return {
      icon: ShieldAlert,
      title: 'Access denied',
      description: `Access to this page${host ? ` on ${host}` : ''} was refused (${label}).`
    }
  }
  if (code === 404 || code === 410) {
    return {
      icon: FileWarning,
      title: 'Page not found',
      description: `There is no page at this address${host ? ` on ${host}` : ''} (${label}). Check the address for typos.`
    }
  }
  if (code === 408 || code === 504) {
    return {
      icon: Clock,
      title: 'The server timed out',
      description: `${host ? `The server at ${host} did` : 'The server did'} not answer in time (${label}). Try again in a moment.`
    }
  }
  if (code === 429) {
    return {
      icon: Clock,
      title: 'Too many requests',
      description: `${host ? `${host} is` : 'The server is'} rate limiting this address (${label}). Wait a moment, then reload.`
    }
  }
  if (code === 502) {
    return {
      icon: ServerCrash,
      title: 'Bad gateway',
      description: `The server reached a gateway that answered wrongly${host ? ` for ${host}` : ''} (${label}). This is often temporary.`
    }
  }
  if (code === 503) {
    return {
      icon: ServerCrash,
      title: 'Service unavailable',
      description: `${host ? `${host} is` : 'The server is'} temporarily unavailable (${label}). Reload in a moment.`
    }
  }
  if (code >= 500) {
    return {
      icon: ServerCrash,
      title: 'The server errored',
      description: `${host ? `${host} could` : 'The server could'} not serve this page (${label}). Reloading may help.`
    }
  }
  return {
    icon: FileWarning,
    title: 'The page could not load',
    description: `${host ? `${host} answered` : 'The server answered'} with an error (${label}).`
  }
}

function networkErrorCopy(code: number, host: string): BrowserLoadErrorCopy {
  if (code === -106 || code === -21) {
    return {
      icon: WifiOff,
      title: 'You are offline',
      description: 'This device has no network connection. Reconnect, then reload.'
    }
  }
  if (code === -105 || code === -137) {
    return {
      icon: Globe,
      title: 'Site not found',
      description: `The server could not be found${host ? ` for ${host}` : ''}. Check the address for typos.`
    }
  }
  if (code === -102) {
    return {
      icon: PlugZap,
      title: 'Connection refused',
      description: `The connection was refused${host ? ` by ${host}` : ''}. The server there may not be running.`
    }
  }
  if (code === -101 || code === -117) {
    return {
      icon: Unplug,
      title: 'Connection reset',
      description: `The connection${host ? ` to ${host}` : ''} closed before the page arrived. Reload to try again.`
    }
  }
  if (code === -104 || code === -109) {
    return {
      icon: Unplug,
      title: 'Server unreachable',
      description: `The server could not be reached${host ? ` at ${host}` : ''} from this network.`
    }
  }
  if (code === -7 || code === -118) {
    return {
      icon: Clock,
      title: 'The connection timed out',
      description: `The connection${host ? ` to ${host}` : ''} timed out. Reload to try again.`
    }
  }
  if (code >= CERTIFICATE_ERROR_START && code <= CERTIFICATE_ERROR_END) {
    return {
      icon: ShieldAlert,
      title: 'Connection not secure',
      description: `A secure connection could not be established${host ? ` with ${host}` : ''}.`
    }
  }
  if (code === -324) {
    return {
      icon: FileWarning,
      title: 'The server sent nothing',
      description: `The server${host ? ` at ${host}` : ''} closed the connection without sending a page. Reload to try again.`
    }
  }
  if (code === -20 || code === -27) {
    return {
      icon: Ban,
      title: 'Request blocked',
      description: `The request was blocked${host ? ` for ${host}` : ''}.`
    }
  }
  return {
    icon: CircleAlert,
    title: 'This page could not load',
    description: `The page could not be reached${host ? ` at ${host}` : ''}. Reload to try again.`
  }
}
