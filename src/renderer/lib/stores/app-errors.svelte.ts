import { toast } from 'svelte-sonner'
import { workspaceState } from '$lib/stores/workspace.svelte'

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

interface CaptureOptions {
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

type ToastFn = (message: string, data?: Parameters<typeof toast.error>[1]) => string | number

function captureWith(kind: AppErrorKind, original: ToastFn): ToastFn {
  return (message, data) => {
    if (typeof message === 'string') {
      // Toasts that carry an action (e.g. agent notifications) are thread-navigable
      // through their own UI, so we don't guess a thread link for them here.
      const thread = data?.action ? undefined : currentThreadRef()
      appErrorState.capture(kind, message, { thread })
    }
    return original(message, data)
  }
}

const originalError = toast.error
const originalWarning = toast.warning

toast.error = captureWith('error', toast.error) as typeof toast.error
toast.warning = captureWith('warning', toast.warning) as typeof toast.warning

function messageFrom(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

/** Surface an error toast carrying the full error payload (stack, cause chain). */
export function reportError(error: unknown, fallback: string, thread?: AppErrorThreadRef): void {
  const message = messageFrom(error, fallback)
  appErrorState.capture('error', message, {
    details: error instanceof Error ? serializeError(error) : undefined,
    thread: thread ?? currentThreadRef()
  })
  originalError(message, { closeButton: true })
}

/** Surface a preformatted error message (e.g. from the main process) with optional details. */
export function reportErrorWithDetails(
  message: string,
  options?: { details?: string; thread?: AppErrorThreadRef }
): void {
  appErrorState.capture('error', message, options)
  originalError(message, { closeButton: true })
}
