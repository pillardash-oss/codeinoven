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

/**
 * Marks the Copy action this module injects. Sonner renders `action` and
 * `cancel` as two separate buttons, so an injected Copy must be recognisable:
 * a wrapper that runs twice (see `installToastCapture`) would otherwise read
 * our own `action` as a caller-owned action and add a second Copy beside it.
 */
const INJECTED_COPY = Symbol('codeinoven.injected-toast-copy')

interface ToastCopyAction {
  label: string
  onClick: () => void
  [INJECTED_COPY]: true
}

function isInjectedCopy(value: unknown): boolean {
  return typeof value === 'object' && value !== null && INJECTED_COPY in value
}

/** Full clipboard text for an error: message plus any details/stack. */
function errorText(message: string, details?: string): string {
  return details ? `${message}\n\n${details}` : message
}

/** The Copy button every error toast carries. */
function copyAction(text: string): ToastCopyAction {
  return {
    label: 'Copy',
    [INJECTED_COPY]: true,
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
 *
 * A toast that already carries our Copy is returned unchanged: one toast shows
 * one Copy button, no matter how many times the wrappers ran.
 */
function withCopyButton(message: string, data: ToastData, details?: string): ToastData {
  if (isInjectedCopy(data?.action) || isInjectedCopy(data?.cancel)) return data
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

/**
 * Sonner exports one shared `toast` object for the whole renderer, so these
 * wrappers are global side effects: they must be installed on the *original*
 * functions, never on a previous wrapper. Wrapping a wrapper is exactly how an
 * error toast ended up with two Copy buttons, because the outer wrapper read
 * the inner wrapper's injected `action` as a caller-owned action and added a
 * `cancel` Copy next to it.
 *
 * The pristine functions therefore live on the `toast` object itself under a
 * `Symbol.for` key: re-evaluating this module (Vite HMR in development) finds
 * them and replaces the previous wrapper instead of stacking another one.
 */
const PRISTINE_TOAST_FNS = Symbol.for('codeinoven.pristine-toast-fns')

interface PristineToastFns {
  error: typeof toast.error
  warning: typeof toast.warning
}

/** A symbol-indexed view of a host object (the shared `toast` object, the
 *  `window`), used to store and read the registries below. */
type SymbolRegistryHost = { [key: symbol]: unknown }

/** Install the capture wrappers and return the pristine sonner functions.
 *  Returns `void` outside the browser, where there is no toast to wrap. */
function installToastCapture(): PristineToastFns | undefined {
  if (typeof window === 'undefined') return undefined
  const host = toast as unknown as SymbolRegistryHost
  const registered = host[PRISTINE_TOAST_FNS] as PristineToastFns | undefined
  const pristine: PristineToastFns = registered ?? {
    error: toast.error,
    warning: toast.warning
  }
  host[PRISTINE_TOAST_FNS] = pristine

  /** Capture an error toast, then show it with its Copy button guaranteed. */
  const errorWithCapture = (message: ToastMessage, data?: ToastData): string | number => {
    // A non-string message is a component renderer with no text to capture.
    if (typeof message !== 'string') return pristine.error(message, data)
    captureToast('error', message, data)
    return pristine.error(message, withCopyButton(message, data))
  }

  toast.error = errorWithCapture as typeof toast.error
  toast.warning = captureWith('warning', pristine.warning) as typeof toast.warning

  return pristine
}

const pristineToasts = installToastCapture()
/** Sonner's own functions, so toasts shown by this module never pass through
 *  the capture wrapper above a second time. Outside the browser the shared
 *  object is unwrapped and these fall back to it directly. */
const originalError: ToastFn = pristineToasts?.error ?? (toast.error as ToastFn)
const originalWarning: ToastFn = pristineToasts?.warning ?? (toast.warning as ToastFn)

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
const UNCAUGHT_CAPTURE_DISPOSE = Symbol.for('codeinoven.uncaught-error-capture-dispose')

function installUncaughtErrorCapture(): void {
  if (typeof window === 'undefined') return
  const host = window as unknown as SymbolRegistryHost
  // A re-evaluation of this module replaces the previous pair: leaving them
  // behind would stack listeners that capture into a discarded state instance.
  const disposePrevious = host[UNCAUGHT_CAPTURE_DISPOSE] as (() => void) | undefined
  disposePrevious?.()
  const onError = (event: ErrorEvent) => {
    const error: unknown = event.error
    appErrorState.capture('error', messageFrom(error, event.message || 'Uncaught app error'), {
      details: error instanceof Error ? serializeError(error) : undefined,
      thread: currentThreadRef()
    })
  }
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason: unknown = event.reason
    appErrorState.capture('error', messageFrom(reason, 'Unhandled promise rejection'), {
      details: reason instanceof Error ? serializeError(reason) : undefined,
      thread: currentThreadRef()
    })
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  host[UNCAUGHT_CAPTURE_DISPOSE] = () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
  }
}

installUncaughtErrorCapture()
