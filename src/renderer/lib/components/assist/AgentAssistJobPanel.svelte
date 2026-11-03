<script lang="ts">
  import { reportError } from '$lib/stores/app-errors.svelte'
  import JobPanel from '../ui/JobPanel.svelte'
  import type { JobStepView } from '../ui/job-view'
  import { openAssistThread } from './agent-assist-run'
  import { ASSIST_STEPS, agentAssistJobs, type AgentAssistJob } from './agent-assist-jobs.svelte'
  interface Props {
    job: AgentAssistJob
  }
  let { job }: Props = $props()
  const steps = $derived.by((): JobStepView[] => {
    // A reviewed brief's preparation ends at the prompt. Once that prompt is
    // sent the job is a live run, so it reports the same steps as one that was
    // sent immediately.
    const reviewing = job.delivery === 'draft' && !job.started
    const stages = reviewing ? ASSIST_STEPS.slice(0, 4) : ASSIST_STEPS
    const active = stages.findIndex((step) => step.id === job.stage)
    return [
      ...stages.map((step, index): JobStepView => ({
        id: step.id,
        label: reviewing && step.id === 'dispatch' ? 'Opening the prompt for review' : step.label,
        state:
          job.status === 'succeeded' || index < active
            ? 'complete'
            : index > active
              ? 'pending'
              : job.status === 'failed'
                ? 'failed'
                : 'active',
        ...(index === active && job.detail && job.detail !== step.label
          ? { detail: job.detail }
          : {})
      })),
      ...job.tools
    ]
  })
  function openThread(): void {
    if (job.threadId)
      void openAssistThread(job.projectId, job.threadId).catch((error: unknown) =>
        reportError(error, 'Could not open the agent thread.')
      )
  }
</script>

<JobPanel
  layer="top"
  title={job.title}
  status={job.status}
  statusLabel={job.status === 'running'
    ? job.detail || 'Preparing'
    : job.status === 'failed'
      ? 'Failed'
      : job.delivery === 'draft'
        ? 'Prompt ready'
        : 'Agent finished'}
  {steps}
  error={job.error}
  note={job.status === 'running'
    ? job.awaitingSend
      ? 'Edit and send the prompt in the thread. This panel follows the run from there.'
      : 'You can keep working. Progress continues here and in the thread.'
    : job.status === 'failed' && !job.threadId
      ? 'The handoff stopped before a thread was ready. Start a new assistance request to try again.'
      : job.delivery === 'draft'
        ? 'The configured prompt is ready for you to edit and send.'
        : 'Open the thread for the full result and any requested answers.'}
  minimized={job.minimized}
  onMinimize={() => agentAssistJobs.minimize(job.id)}
  onClose={() => agentAssistJobs.close(job.id)}
  storageKey={`agent-assist-job-${job.id}`}
  actionWhileRunning
  actionLabel={job.threadId ? 'Open thread' : undefined}
  onAction={job.threadId ? openThread : undefined}
/>
