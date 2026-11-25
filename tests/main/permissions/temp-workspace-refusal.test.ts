import { describe, expect, it } from 'vitest'
import {
  ChatEnginePermissions,
  tempWorkspaceRequestReferences
} from '../../../src/main/chat/chat-engine/chat-engine-permissions'
import type { PendingPermissionInfo } from '../../../src/main/chat/chat-engine/chat-engine-types'
import type { PermissionRequest } from '../../../src/lib/types'

/**
 * The OS temp directory ban, enforced by the engine for every harness.
 *
 * A temp path is never something to approve: it is work in the wrong place when
 * the session has its own scratch folder. Every harness that asks the app before
 * it writes or runs a shell command passes through `handlePermissionAsked`, so
 * the refusal has to happen here, before the policy and before any card, and it
 * has to carry the scratch folder the agent should use instead.
 */

const PROJECT_PATH = '/Users/me/codeinoven'

function request(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'request-1',
    sessionId: 'session-1',
    permission: 'shell',
    patterns: [],
    metadata: { command: 'rm -rf /tmp/cio-crlf' },
    ...overrides
  }
}

interface RefusalHarness {
  unit: ChatEnginePermissions
  driver: { id: string; replyPermission: (...args: never[]) => Promise<void> }
  replies: Array<{ reply: string; message?: string }>
  log: string[]
  pendingPermissions: Map<string, PendingPermissionInfo>
}

function harness(): RefusalHarness {
  const pendingPermissions = new Map<string, PendingPermissionInfo>()
  const replies: Array<{ reply: string; message?: string }> = []
  const log: string[] = []
  const host = {
    state: { pendingPermissions },
    storage: {
      appendRaw: async (path: string, line: string) => {
        log.push(`${path}:${line}`)
      },
      getConfig: async () => ({})
    },
    sessionRegistry: new Map([
      [
        'session-1',
        {
          sessionId: 'session-1',
          projectId: 'project-1',
          threadId: 'thread-1',
          projectPath: PROJECT_PATH,
          permissionLevel: 'full_access',
          driverId: 'pi'
        }
      ]
    ]),
    units: {
      turns: { markProjectActive: () => undefined },
      'temporary-chats': { temporaryChatForSession: () => undefined }
    },
    threadManager: { getThread: async () => null, setStatus: async () => undefined },
    broadcast: () => undefined
  }
  const unit = new ChatEnginePermissions(host as never)
  const driver = {
    id: 'pi',
    replyPermission: async (
      _projectPath: string,
      _requestId: string,
      reply: string,
      message?: string
    ) => {
      replies.push({ reply, ...(message === undefined ? {} : { message }) })
    }
  }
  return { unit, driver, replies, log, pendingPermissions }
}

describe('the OS temp directory refusal', () => {
  it('refuses a shell command in temp with the scratch folder named, in every mode', async () => {
    const test = harness()

    await test.unit.handlePermissionAsked(
      'pi',
      { type: 'permission.asked', sessionId: 'session-1', permission: request() },
      // Full Access is the mode that would otherwise auto-approve everything.
      test.driver as never
    )

    expect(test.replies).toHaveLength(1)
    expect(test.replies[0]?.reply).toBe('reject')
    expect(test.replies[0]?.message).toContain('/Users/me/codeinoven/.cio/tmp')
    expect(test.replies[0]?.message).toContain('/tmp')
    // Nothing is left waiting for the user: a refused action is answered.
    expect(test.pendingPermissions.size).toBe(0)
    expect(test.log.join('\n')).toContain('policy:temp-workspace')
  })

  it('accepts a read of a temp file the user attached', () => {
    const references = tempWorkspaceRequestReferences(request({ permission: 'read' }), [])

    expect(tempWorkspaceRequestReferences(request(), ['rm -rf /tmp/cio-crlf'])).toHaveLength(1)
    expect(references).toHaveLength(0)
  })

  it('accepts work in the session’s own scratch folder', () => {
    const own = request({
      metadata: { command: 'mkdir -p .cio/tmp/site && echo hi > .cio/tmp/site/index.html' }
    })
    const write = request({
      permission: 'write',
      patterns: ['.cio/tmp/report.md'],
      metadata: {}
    })

    expect(tempWorkspaceRequestReferences(own, ['.cio/tmp/site/index.html'])).toHaveLength(0)
    expect(tempWorkspaceRequestReferences(write, [])).toHaveLength(0)
  })
})
