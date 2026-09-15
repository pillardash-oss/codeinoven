import { toast } from 'svelte-sonner'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { copyText } from '$lib/copy-text'

export type AppErrorKind = 'error' | 'warning'

export interface AppErrorThreadRef {
  projectId: string
  threadId: string
}

export interface AppErrorEntry {
  id: string
  kind: AppErrorKind
  message: string
  timestamp: number
  count: number
  details?: string
  projectId?: string
  threadId?: string
}

export interface CaptureOptions {
  details?: string
  thread?: AppErrorThreadRef
}

const MAX_ENTRIES = 100

function serializeError(error: unknown): string | undefined {
  if (error instanceof Error) {
    const lines: string[] = [`${error.name}: ${error.message}`]
    if (error.stack) lines.push(error.stack)
    let cause: unknown = error.cause
    while (cause instanceof Error) {
      lines.push(`Caused by: ${cause.name}: ${cause.message}`)
      if (cause.stack) lines.push(cause.stack)
      cause = cause.cause
    }
    return lines.join('\n\n')
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error, null, 2)
  } catch {
    return String(error)
  }
}

function currentThreadRef(): AppErrorThreadRef | undefined {
  const thread = workspaceState.selectedThread
  if (!thread) return undefined
  return { projectId: thread.projectId, threadId: thread.id }
}

class AppErrorState {
  private _entries: AppErrorEntry[] = $state([])

  get entries(): AppErrorEntry[] {
    return this._entries
  }

  get count(): number {
    return this._entries.length
  }

  /** Record an error/warning. In-memory only; never persisted. */
  capture(kind: AppErrorKind, message: string, options?: CaptureOptions): void {
    const normalized = message.trim()
    if (!normalized) return
    const existing = this._entries.find((e) => e.kind === kind && e.message === normalized)
    if (existing) {
      this._entries = this._entries.map((e) =>
        e.id === existing.id
          ? {
              ...e,
              count: e.count + 1,
              details: e.details ?? options?.details,
              projectId: e.projectId ?? options?.thread?.projectId,
              threadId: e.threadId ?? options?.thread?.threadId
            }
          : e
      )
      return
    }
    const entry: AppErrorEntry = {
      id: crypto.randomUUID(),
      kind,
      message: normalized,
      timestamp: Date.now(),
      count: 1,
      details: options?.details,
      projectId: options?.thread?.projectId,
      threadId: options?.thread?.threadId
    }
    this._entries = [entry, ...this._entries].slice(0, MAX_ENTRIES)
  }

  dismiss(id: string): void {
    this._entries = this._entries.filter((e) => e.id !== id)
  }

  dismissAll(): void {
    this._entries = []
  }
}

export const appErrorState = new AppErrorState()

type ToastData = Parameters<typeof toast.error>[1]
type ToastFn = (message: string, data?: ToastData) => string | number

type ToastMessage = Parameters<typeof toast.error>[0]

/** Full clipboard text for an error: message plus any details/stack. */
function errorText(message: string, details?: string): string {
  return details ? `${message}\n\n${details}` : message
}

/** The Copy button every error toast carries. */
function copyAction(text: string): { label: string; onClick: () => void } {
  return {
    label: 'Copy',
    onClick: () => {
      void copyText(text).catch(() => {})
    }
  }
}

/**
 * Guarantee a Copy button on every error toast. Sonner renders one primary
 * `action` and one secondary `cancel` button, so when the caller already owns
 * the action (a thread-navigating "Open thread", a retry, ...) the copy takes
 * the secondary slot instead of being dropped.
 */
function withCopyButton(message: string, data: ToastData, details?: string): ToastData {
  const copy = copyAction(errorText(message, details))
  if (!data?.action) return { ...data, action: copy }
  if (data.cancel) return data
  return { ...data, cancel: copy }
}

/** Record a toast in the app errors panel. Toasts that carry an action (e.g.
 *  agent notifications) are thread-navigable through their own UI, so we don't
 *  guess a thread link for them here. */
function captureToast(kind: AppErrorKind, message: string, data: ToastData): void {
  const thread = data?.action ? undefined : currentThreadRef()
  appErrorState.capture(kind, message, { thread })
}

function captureWith(kind: AppErrorKind, original: ToastFn): ToastFn {
  return (message, data) => {
    if (typeof message === 'string') captureToast(kind, message, data)
    return original(message, data)
  }
}

const originalError = toast.error
const originalWarning = toast.warning

/** Capture an error toast, then show it with its Copy button guaranteed. */
function errorToastWithCapture(message: ToastMessage, data?: ToastData): string | number {
  if (typeof message !== 'string') return originalError(message, data)
  captureToast('error', message, data)
  return originalError(message, withCopyButton(message, data))
}

toast.error = errorToastWithCapture as typeof toast.error
toast.warning = captureWith('warning', originalWarning) as typeof toast.warning

function messageFrom(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

/** First user-facing line of a multi-line diagnostic text. */
export function errorHeadline(text: string): string {
  const first = text.split('\n', 1)[0]?.trim()
  return first && first.length > 0 ? first : text.trim()
}

/**
 * Record an error in the app-errors panel without showing a toast. For callers
 * that own their toast (e.g. agent error notifications with a thread-navigating
 * action) so the panel still gets the full diagnostic text.
 */
export function captureError(message: string, options?: CaptureOptions): void {
  appErrorState.capture('error', message, options)
}

/** Show an error toast without re-capturing it. Pair with `captureError` when
 *  the caller records the error itself (with details) before toasting. */
export function showToastError(message: string, data?: ToastData): string | number {
  return originalError(message, withCopyButton(message, data))
}

/** Show a warning toast without recording it. Thread status notices ("needs
 *  attention") belong to the notification panel's Attention tab, so they must
 *  never duplicate into the app errors panel. */
export function showToastWarning(message: string, data?: ToastData): string | number {
  return originalWarning(message, data)
}

/** Surface an error toast carrying the full error payload (stack, cause chain). */
export function reportError(error: unknown, fallback: string, thread?: AppErrorThreadRef): void {
  const message = messageFrom(error, fallback)
  const details = error instanceof Error ? serializeError(error) : undefined
  appErrorState.capture('error', message, {
    details,
    thread: thread ?? currentThreadRef()
  })
  originalError(message, withCopyButton(message, undefined, details))
}

/** Surface a preformatted error message (e.g. from the main process) with optional details. */
export function reportErrorWithDetails(
  message: string,
  options?: { details?: string; thread?: AppErrorThreadRef }
): void {
  appErrorState.capture('error', message, options)
  originalError(message, withCopyButton(message, undefined, options?.details))
}

/**
 * Mirror uncaught renderer failures into the panel with their stack trace.
 * These never pass through a toast call, so without this they would only exist
 * in the durable log while the panel stayed silent about a real app error.
 */
function installUncaughtErrorCapture(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (event) => {
    const error: unknown = event.error
    appErrorState.capture('error', messageFrom(error, event.message || 'Uncaught app error'), {
      details: error instanceof Error ? serializeError(error) : undefined,
      thread: currentThreadRef()
    })
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason
    appErrorState.capture('error', messageFrom(reason, 'Unhandled promise rejection'), {
      details: reason instanceof Error ? serializeError(reason) : undefined,
      thread: currentThreadRef()
    })
  })
}

installUncaughtErrorCapture()
