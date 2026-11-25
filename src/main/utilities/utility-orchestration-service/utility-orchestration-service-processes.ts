import type { AgentProcessExecutor } from '../utility-orchestration-service'
import { optionalString } from '../utility-orchestration/utility-input'

/** What the process tools need from the service: the executor the engine registered. */
interface AgentProcessToolHost {
  agentProcessExecutor: AgentProcessExecutor | null
}

/** What a process tool needs from the turn: whose project, thread and session it is. */
interface AgentProcessTurn {
  request: {
    projectId: string
    threadId: string
    projectPath: string
    sessionId: string
    harnessId: string
  }
}

/** Most characters a background command may carry. */
const COMMAND_LIMIT = 4_000
/** Most characters a process label may carry. */
const LABEL_LIMIT = 120

/** One validated `cio_process_stop` request. */
function readPid(input: Record<string, unknown>): number {
  const pid = input['pid']
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) {
    throw new TypeError('pid must be a process id greater than 1')
  }
  return pid
}

/**
 * UtilityOrchestrationService processes: the app-owned process tools.
 *
 * `cio_process_list`, `cio_process_start` and `cio_process_stop` are granted on
 * every turn that carries the gateway, because an agent that can start a
 * long-running process must be able to see it and stop it. Validation lives
 * here; the ownership check, the spawn environment and the stop itself live in
 * the chat engine's executor, which owns the process service.
 */
export class UtilityOrchestrationServiceProcesses {
  constructor(private readonly host: AgentProcessToolHost) {}

  /** List, start or stop one process for the turn that asked. */
  async run(
    state: AgentProcessTurn,
    input: Record<string, unknown>,
    action: string
  ): Promise<unknown> {
    const executor = this.host.agentProcessExecutor
    if (!executor) {
      throw new Error(
        'The app process tools are unavailable in this session: it has no chat engine to own a process.'
      )
    }
    const context = {
      projectId: state.request.projectId,
      threadId: state.request.threadId,
      projectPath: state.request.projectPath,
      sessionId: state.request.sessionId,
      harnessId: state.request.harnessId
    }
    if (action === 'list') return executor('list', {}, context)
    if (action === 'start') {
      const command = optionalString(input['command'], COMMAND_LIMIT)
      if (!command) throw new TypeError('command must be a non-empty shell command')
      const cwd = optionalString(input['cwd'], 1_024)
      const label = optionalString(input['label'], LABEL_LIMIT)
      return executor(
        'start',
        { command, ...(cwd ? { cwd } : {}), ...(label ? { label } : {}) },
        context
      )
    }
    if (action === 'stop') {
      const pid = readPid(input)
      return executor('stop', { pid, force: input['force'] === true }, context)
    }
    throw new TypeError(`Unknown process action: ${action}`)
  }
}
