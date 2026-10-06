import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeMcpServerFailure } from '../../../src/lib/types'
import {
  notifyNativeMcpFailure,
  nativeMcpFailureMessage
} from '../../../src/main/utilities/native-mcp-notice'

const toasts = vi.hoisted(() => ({ sent: [] as unknown[] }))

vi.mock('../../../src/main/ipc/app-toast', () => ({
  broadcastAppToast: (payload: unknown) => toasts.sent.push(payload)
}))

vi.mock('../../../src/main/system/logger', () => ({
  Logger: { dev: vi.fn(), info: vi.fn(), error: vi.fn(), flush: vi.fn() }
}))

/**
 * What the user is told when a utility they enabled did not reach the
 * harness's own MCP host: it names the utility when the app knows one, names
 * the server when it does not, and always says the gateway still serves it,
 * because a message that only reports a failure sends someone hunting for a
 * broken thread that is not broken.
 */
describe('native MCP failure notice', () => {
  beforeEach(() => {
    toasts.sent.splice(0)
  })

  it('names the utility and its server', () => {
    expect(
      nativeMcpFailureMessage({
        sessionId: 's-1',
        utilityId: 'slack-mcp',
        utilityName: 'Slack MCP',
        server: 'slack_mcp',
        reason: 'invalid config.'
      })
    ).toBe(
      'Pi would not run "Slack MCP" (slack_mcp) on its own MCP host: invalid config. The utility gateway still serves it.'
    )
  })

  it('falls back to the server name, then to the fact that a server failed', () => {
    const base: NativeMcpServerFailure = { sessionId: 's-1', reason: 'boom.' }
    expect(nativeMcpFailureMessage({ ...base, server: 'slack_mcp' })).toBe(
      'Pi would not run "slack_mcp" on its own MCP host: boom. The utility gateway still serves it.'
    )
    expect(nativeMcpFailureMessage(base)).toBe(
      'Pi would not run an MCP server on its own MCP host: boom. The utility gateway still serves it.'
    )
  })

  it('carries the thread so the toast links back to it', () => {
    notifyNativeMcpFailure(
      { sessionId: 's-1', utilityName: 'Slack MCP', server: 'slack_mcp', reason: 'boom.' },
      { projectId: 'p-1', threadId: 't-1' }
    )

    expect(toasts.sent).toEqual([
      {
        message:
          'Pi would not run "Slack MCP" (slack_mcp) on its own MCP host: boom. The utility gateway still serves it.',
        type: 'error',
        projectId: 'p-1',
        threadId: 't-1'
      }
    ])
  })
})
