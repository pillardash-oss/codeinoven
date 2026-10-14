import { describe, expect, it } from 'vitest'
import type { AgentPart } from '../../src/lib/types'
import {
  describeNativeMcpCall,
  nativeMcpCallIdentity,
  overdueNativeMcpCall,
  trackNativeMcpCall,
  type OpenNativeMcpCall
} from '../../src/main/chat/chat-engine/native-mcp-call-window'

type ToolPart = Extract<AgentPart, { type: 'tool' }>

function toolPart(
  overrides: {
    id?: string
    tool?: string
    status?: ToolPart['state']['status']
    metadata?: Record<string, unknown>
  } = {}
): ToolPart {
  return {
    type: 'tool',
    id: overrides.id ?? 'call-1',
    messageID: 'msg-1',
    callID: overrides.id ?? 'call-1',
    tool: overrides.tool ?? 'mcp__svelte_mcp__svelte_autofixer',
    state: {
      status: overrides.status ?? 'running',
      input: {},
      ...(overrides.metadata ? { metadata: overrides.metadata } : {})
    }
  }
}

const attribution = {
  utilityId: 'svelte-mcp',
  utilityName: 'Svelte MCP',
  server: 'svelte_mcp',
  tool: 'svelte_autofixer'
}

describe('native MCP call window', () => {
  it('reads the attribution the fold writes for a native call', () => {
    expect(nativeMcpCallIdentity(toolPart({ metadata: attribution }))).toEqual({
      server: 'svelte_mcp',
      tool: 'svelte_autofixer',
      utilityName: 'Svelte MCP'
    })
  })

  it('ignores a call that went through the app gateway', () => {
    // A gateway call has no `server`/`tool` attribution: the gateway bounds it
    // itself, so the watchdog must not track it here.
    expect(nativeMcpCallIdentity(toolPart())).toBeNull()
    expect(nativeMcpCallIdentity(toolPart({ metadata: { utilityId: 'x' } }))).toBeNull()
  })

  it('keeps the first started time across repeated running updates', () => {
    const calls = new Map<string, OpenNativeMcpCall>()
    trackNativeMcpCall(calls, toolPart({ metadata: attribution }), 1_000)
    trackNativeMcpCall(calls, toolPart({ metadata: attribution }), 9_000)
    expect(calls.get('call-1')?.startedAt).toBe(1_000)
  })

  it('drops a call once it settles', () => {
    const calls = new Map<string, OpenNativeMcpCall>()
    trackNativeMcpCall(calls, toolPart({ metadata: attribution }), 1_000)
    trackNativeMcpCall(calls, toolPart({ metadata: attribution, status: 'completed' }), 2_000)
    expect(calls.size).toBe(0)
  })

  it('reports only a call past the ceiling', () => {
    const calls = new Map<string, OpenNativeMcpCall>([
      ['call-1', { server: 'svelte_mcp', tool: 'svelte_autofixer', startedAt: 1_000 }]
    ])
    expect(overdueNativeMcpCall(calls, 1_000 + 179_999, 180_000)).toBeNull()
    expect(overdueNativeMcpCall(calls, 1_000 + 180_000, 180_000)).not.toBeNull()
  })

  it('names the utility in the message the user reads', () => {
    expect(
      describeNativeMcpCall({
        server: 'svelte_mcp',
        tool: 'svelte_autofixer',
        utilityName: 'Svelte MCP',
        startedAt: 0
      })
    ).toBe('Svelte MCP (svelte_autofixer)')
    expect(
      describeNativeMcpCall({ server: 'svelte_mcp', tool: 'svelte_autofixer', startedAt: 0 })
    ).toBe('svelte_mcp/svelte_autofixer')
  })
})
