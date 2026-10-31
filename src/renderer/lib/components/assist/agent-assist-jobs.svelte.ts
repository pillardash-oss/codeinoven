import { subscribe } from '$lib/ipc.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import type { AgentEvent } from '$shared/types'
import type { JobStatus, JobStepView } from '../ui/job-view'
import type {
  AgentAssistDelivery,
  AgentAssistRequest,
  AgentAssistSelection
} from './agent-assist-store.svelte'
import { runAgentAssist, type AgentAssistProgress } from './agent-assist-run'

export interface AgentAssistJob {
  id: string
  projectId: string
  title: string
  delivery: AgentAssistDelivery
  stage: AgentAssistProgress['stage']
  detail: string
  threadId: string | null
  status: JobStatus
  error: string | null
  minimized: boolean
  started: boolean
  tools: JobStepView[]
}

export const ASSIST_STEPS = [
  { id: 'project', label: 'Reading the project' },
  { id: 'scope', label: 'Preparing the checkout' },
  { id: 'thread', label: 'Preparing the thread and prompt' },
  { id: 'dispatch', label: 'Starting the agent' },
  { id: 'agent', label: 'Agent working' }
] as const

class AgentAssistJobs {
  jobs = $state<AgentAssistJob[]>([])
  private listeners: Array<() => void> = []

  start(
    request: AgentAssistRequest,
    selection: AgentAssistSelection,
    delivery: AgentAssistDelivery
  ): string {
    const job: AgentAssistJob = {
      id: crypto.randomUUID(),
      projectId: request.projectId,
      title: request.title,
      delivery,
      stage: 'project',
      detail: 'Reading the project',
      threadId: null,
      status: 'running',
      error: null,
      minimized: false,
      started: false,
      tools: []
    }
    const retained = new Set(
      this.jobs
        .filter((entry) => entry.status !== 'running')
        .slice(-19)
        .map((entry) => entry.id)
    )
    this.jobs = [
      ...this.jobs.filter((entry) => entry.status === 'running' || retained.has(entry.id)),
      job
    ]
    this.listen()
    void runAgentAssist(request, selection, delivery, (progress) => {
      this.patch(job.id, {
        stage: progress.stage,
        detail: progress.detail ?? '',
        ...(progress.threadId ? { threadId: progress.threadId } : {})
      })
    })
      .then(() => {
        if (delivery === 'draft') this.finish(job.id, 'succeeded')
      })
      .catch((error: unknown) => {
        this.finish(
          job.id,
          'failed',
          error instanceof Error ? error.message : 'The agent handoff failed.'
        )
      })
    return job.id
  }

  minimize(id: string): void {
    this.patch(id, { minimized: true })
  }
  expand(id: string): void {
    this.patch(id, { minimized: false })
  }
  close(id: string): void {
    this.jobs = this.jobs.filter((job) => job.id !== id || job.status === 'running')
  }

  private patch(id: string, patch: Partial<AgentAssistJob>): void {
    const job = this.jobs.find((entry) => entry.id === id)
    if (job && job.status === 'running') Object.assign(job, patch)
    else if (job && 'minimized' in patch) job.minimized = patch.minimized ?? false
  }

  private finish(id: string, status: JobStatus, error: string | null = null): void {
    this.patch(id, {
      status,
      error,
      detail: error ?? (status === 'succeeded' ? 'Ready' : 'Stopped')
    })
    if (!this.jobs.some((job) => job.status === 'running')) {
      for (const dispose of this.listeners) dispose()
      this.listeners = []
    }
  }

  private listen(): void {
    if (this.listeners.length) return
    this.listeners = [
      subscribe('agent:event', (event) => this.event(event)),
      subscribe('agent:remoteEvent', ({ event }) => this.event(event)),
      subscribe('thread:updated', (thread) => {
        const job = this.jobs.find(
          (entry) =>
            entry.status === 'running' &&
            entry.started &&
            entry.projectId === thread.projectId &&
            entry.threadId === thread.id
        )
        if (!job) return
        if (thread.status === 'failed' || thread.status === 'interrupted') {
          this.finish(
            job.id,
            'failed',
            thread.status === 'interrupted'
              ? 'The agent was stopped.'
              : 'The agent run failed. Open the thread for details.'
          )
          return
        }
        // A parked run is still the user's work: the provider refused the turn
        // or has to be retried, and saying "Agent working" would be a lie.
        if (thread.status === 'working-paused') {
          this.patch(job.id, { detail: 'Waiting to retry the provider' })
          return
        }
        if (thread.status === 'completed') this.finish(job.id, 'succeeded')
      })
    ]
  }

  private event(event: AgentEvent): void {
    // Ignore token deltas entirely. Track only lifecycle and bounded tool summaries.
    if (
      !('sessionId' in event) ||
      ![
        'session.status',
        'session.idle',
        'session.error',
        'message.part.updated',
        'permission.asked',
        'question.asked',
        'message.completed'
      ].includes(event.type)
    )
      return
    if (event.type === 'message.part.updated' && event.part.type !== 'tool') return
    const target = threadMessages.conversationForSession(event.sessionId)
    if (!target) return
    const job = this.jobs.find(
      (entry) =>
        entry.status === 'running' &&
        entry.delivery === 'immediate' &&
        entry.projectId === target.projectId &&
        entry.threadId === target.conversationId
    )
    if (!job || (job.stage !== 'dispatch' && job.stage !== 'agent')) return
    if (event.type === 'session.error') {
      this.finish(job.id, 'failed', event.error ?? 'The agent stopped with an error.')
    } else if (
      event.type === 'session.idle' ||
      (event.type === 'session.status' && event.status.state === 'idle')
    ) {
      if (job.started) this.finish(job.id, 'succeeded')
    } else if (event.type === 'session.status') {
      if (event.status.state === 'working')
        this.patch(job.id, {
          stage: 'agent',
          started: true,
          detail: event.status.activity?.label ?? 'Agent working'
        })
      else if (event.status.state === 'waiting')
        this.patch(job.id, { detail: 'Waiting for the provider' })
    } else if (event.type === 'permission.asked' || event.type === 'question.asked') {
      this.patch(job.id, { detail: 'Waiting for your answer in the thread' })
    } else if (event.type === 'message.completed') {
      this.patch(job.id, { started: true })
    } else if (event.type === 'message.part.updated' && event.part.type === 'tool') {
      const part = event.part
      const state: JobStepView['state'] =
        part.state.status === 'completed'
          ? 'complete'
          : part.state.status === 'error' || part.state.status === 'aborted'
            ? 'failed'
            : 'active'
      const step = {
        id: part.callID,
        label: (part.state.title || part.actionLabel || part.tool).slice(0, 180),
        state
      }
      const tools = job.tools.filter((tool) => tool.id !== step.id)
      this.patch(job.id, {
        stage: 'agent',
        started: true,
        detail: step.label,
        tools: [...tools.slice(-29), step]
      })
    }
  }
}

export const agentAssistJobs = new AgentAssistJobs()
