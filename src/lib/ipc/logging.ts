/** Where a renderer log line originated, for the durable log tag. */
export type RendererLogSource = 'error' | 'unhandledrejection' | 'console' | 'watchdog'

/** Renderer-level log levels forwarded to the main-process Logger. */
export type RendererLogLevel = 'dev' | 'info' | 'error'

/**
 * A renderer-originated log line forwarded to the main-process durable Logger.
 * Carries only the message/stack and origin label: no paths, user content, or
 * credentials; secrets are redacted by the main-process sink before write.
 */
export interface RendererLogEntry {
  level: RendererLogLevel
  message: string
  stack?: string
  source: RendererLogSource
  at: number
}
