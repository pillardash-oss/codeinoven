/**
 * What the Pi driver needs from a session client.
 *
 * Two implementations satisfy it: `PiRpcClient`, which drives a `pi --mode rpc`
 * process, and `PiHostClient`, which drives a session on the long-lived CIO Pi
 * host. The driver speaks to this interface so the transport is a choice rather
 * than a second driver.
 */
import type { PiRpcImage } from '../pi-rpc-client'

export interface PiSessionClient {
  readonly running: boolean
  send(command: Record<string, unknown>): Promise<unknown>
  newSession(): Promise<void>
  switchSession(sessionPath: string): Promise<void>
  prompt(
    message: string,
    images?: PiRpcImage[],
    streamingBehavior?: 'steer' | 'followUp'
  ): Promise<void>
  steer(message: string, images?: PiRpcImage[]): Promise<void>
  followUp(message: string, images?: PiRpcImage[]): Promise<void>
  setModel(provider: string, modelId: string): Promise<void>
  setThinkingLevel(level: string): Promise<void>
  abort(): Promise<void>
  compact(customInstructions?: string): Promise<unknown>
  getState(): Promise<unknown>
  getSessionStats(): Promise<unknown>
  getAvailableModels(): Promise<unknown>
  getCommands(): Promise<unknown>
  setAutoCompaction(enabled: boolean): Promise<void>
  setAutoRetry(enabled: boolean): Promise<void>
  respondToExtensionUiRequest(
    requestId: string | number,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean }
  ): void
  /** Stop this session's client. The host itself stays up for other sessions. */
  dispose(): void
}
