import { describe, expect, it, vi } from 'vitest'
import {
  CORE_GATEWAY_TOOL_NAMES,
  GATEWAY_TOOLS,
  PROCESS_LIST_TOOL_NAME,
  PROCESS_START_TOOL_NAME,
  PROCESS_STOP_TOOL_NAME,
  PROCESS_TOOL_NAMES
} from '../../../src/lib/gateway-tools'
import { UtilityOrchestrationServiceProcesses } from '../../../src/main/utilities/utility-orchestration-service/utility-orchestration-service-processes'
import type { AgentProcessExecutor } from '../../../src/main/utilities/utility-orchestration-service'

/**
 * The app owns process lifecycle because a shell kill cannot prove what it
 * started. These tools are the sanctioned path an agent has on every turn, so
 * the catalog shape and the argument validation are pinned here: a tool that is
 * not registered, or a stop that accepts a nonsense pid, would leave an agent
 * unable to end the instance it started.
 */

const TURN = {
  projectId: 'project-1',
  threadId: 'thread-1',
  projectPath: '/tmp/project',
  sessionId: 'session-1',
  harnessId: 'pi'
}

function turnState() {
  return { request: TURN }
}

function processUnit(executor: AgentProcessExecutor | null) {
  return new UtilityOrchestrationServiceProcesses({ agentProcessExecutor: executor })
}

describe('app-owned process tools', () => {
  it('publishes list, start and stop as first-class gateway tools', () => {
    for (const name of PROCESS_TOOL_NAMES) {
      const tool = GATEWAY_TOOLS.find((entry) => entry.name === name)
      expect(tool, `${name} is missing from the gateway catalog`).toBeDefined()
      expect(CORE_GATEWAY_TOOL_NAMES.has(name), `${name} is not registered as a core tool`).toBe(
        true
      )
      expect(tool?.route).toMatch(/^\/process-/u)
      expect(tool?.description.length).toBeGreaterThan(80)
    }
  })

  it('gives every process tool its own route', () => {
    const routes = GATEWAY_TOOLS.filter((tool) => PROCESS_TOOL_NAMES.has(tool.name)).map(
      (tool) => tool.route
    )
    expect(new Set(routes).size).toBe(PROCESS_TOOL_NAMES.size)
  })

  it('requires a pid to stop and a command to start', () => {
    const stop = GATEWAY_TOOLS.find((tool) => tool.name === PROCESS_STOP_TOOL_NAME)
    const start = GATEWAY_TOOLS.find((tool) => tool.name === PROCESS_START_TOOL_NAME)
    const list = GATEWAY_TOOLS.find((tool) => tool.name === PROCESS_LIST_TOOL_NAME)
    expect(stop?.inputSchema['required']).toEqual(['pid'])
    expect(start?.inputSchema['required']).toEqual(['command'])
    expect(list?.inputSchema['additionalProperties']).toBe(false)
  })

  it('answers every action through the executor with the turn it belongs to', async () => {
    const calls: Array<{ action: string; input: Record<string, unknown>; threadId: string }> = []
    const executor: AgentProcessExecutor = async (action, input, context) => {
      calls.push({ action, input, threadId: context.threadId })
      return { ok: true }
    }
    const unit = processUnit(executor)

    await unit.run(turnState(), {}, 'list')
    await unit.run(turnState(), { command: 'bun run dev:probe', label: 'probe' }, 'start')
    await unit.run(turnState(), { pid: 4242, force: true }, 'stop')

    expect(calls).toEqual([
      { action: 'list', input: {}, threadId: 'thread-1' },
      {
        action: 'start',
        input: { command: 'bun run dev:probe', label: 'probe' },
        threadId: 'thread-1'
      },
      { action: 'stop', input: { pid: 4242, force: true }, threadId: 'thread-1' }
    ])
  })

  it('refuses a stop that names no real pid', async () => {
    const run = vi.fn<AgentProcessExecutor>(async () => ({ ok: true }))
    const unit = processUnit(run)
    await expect(unit.run(turnState(), {}, 'stop')).rejects.toThrow(/pid must be/u)
    await expect(unit.run(turnState(), { pid: 0 }, 'stop')).rejects.toThrow(/pid must be/u)
    await expect(unit.run(turnState(), { pid: 1 }, 'stop')).rejects.toThrow(/pid must be/u)
    await expect(unit.run(turnState(), { pid: 1.5 }, 'stop')).rejects.toThrow(/pid must be/u)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a start with no command', async () => {
    const run = vi.fn<AgentProcessExecutor>(async () => ({ ok: true }))
    const unit = processUnit(run)
    await expect(unit.run(turnState(), { command: '  ' }, 'start')).rejects.toThrow(
      /non-empty shell command/u
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('reports a missing engine instead of pretending the pid was handled', async () => {
    const unit = processUnit(null)
    await expect(unit.run(turnState(), {}, 'list')).rejects.toThrow(/unavailable in this session/u)
  })
})
