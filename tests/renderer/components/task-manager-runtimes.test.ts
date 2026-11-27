import { describe, expect, it } from 'vitest'
import type { TaskManagerProcess, TaskManagerService } from '$shared/types'
import { collapseDuplicateRuntimes } from '$lib/components/workspace/task-manager-runtimes'

function processRow(overrides: Partial<TaskManagerProcess> = {}): TaskManagerProcess {
  return {
    pid: 51178,
    parentPid: 1,
    command: '/app/CodeInOven',
    cwd: '/tmp/project',
    projectId: null,
    threadId: null,
    ports: [],
    cpuPercent: 2.4,
    memoryBytes: 170 * 1024 * 1024,
    startedAt: 1_000,
    scope: 'app',
    ...overrides
  }
}

function serviceRow(overrides: Partial<TaskManagerService> = {}): TaskManagerService {
  return {
    id: 'pi-host-51178',
    kind: 'worker',
    name: 'CIO Pi host',
    detail: '3 hosted threads working',
    scope: 'app',
    projectId: null,
    threadId: null,
    pid: 51178,
    port: null,
    url: null,
    startedAt: 1_000,
    stoppable: true,
    cpuPercent: 2.4,
    memoryBytes: 170 * 1024 * 1024,
    ...overrides
  }
}

describe('collapseDuplicateRuntimes', () => {
  it('draws one row for a pid reported as both a service and a process', () => {
    const collapsed = collapseDuplicateRuntimes([processRow()], [serviceRow()])
    expect(collapsed.processes).toEqual([])
    expect(collapsed.services.map((service) => service.name)).toEqual(['CIO Pi host'])
  })

  it('keeps the process row when the service cannot stop the runtime', () => {
    const collapsed = collapseDuplicateRuntimes([processRow()], [serviceRow({ stoppable: false })])
    expect(collapsed.processes.map((process) => process.pid)).toEqual([51178])
    expect(collapsed.services).toEqual([])
  })

  it('keeps a service with no process of its own', () => {
    const gateway = serviceRow({
      id: 'utility-gateway',
      kind: 'server',
      name: 'Utility gateway',
      detail: 'loopback endpoint',
      pid: null,
      stoppable: false,
      cpuPercent: null,
      memoryBytes: null
    })
    const collapsed = collapseDuplicateRuntimes([], [gateway])
    expect(collapsed.services.map((service) => service.id)).toEqual(['utility-gateway'])
  })

  it('never draws a pid twice when two services claim it', () => {
    const collapsed = collapseDuplicateRuntimes(
      [],
      [serviceRow(), serviceRow({ id: 'pi-host-duplicate' })]
    )
    expect(collapsed.services.map((service) => service.id)).toEqual(['pi-host-51178'])
  })

  it('leaves unrelated processes untouched', () => {
    const collapsed = collapseDuplicateRuntimes(
      [processRow(), processRow({ pid: 900, command: '/bin/node vite' })],
      [serviceRow()]
    )
    expect(collapsed.processes.map((process) => process.pid)).toEqual([900])
  })
})
