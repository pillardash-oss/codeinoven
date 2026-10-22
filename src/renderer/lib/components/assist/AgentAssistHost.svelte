<script lang="ts">
  import AgentAssistDialog from './AgentAssistDialog.svelte'
  import { agentAssist } from './agent-assist-store.svelte'
  import { agentAssistJobs } from './agent-assist-jobs.svelte'
  import AgentAssistJobPanel from './AgentAssistJobPanel.svelte'
  import JobDockRow from '../ui/JobDockRow.svelte'
  import { APP_SLUG } from '$shared/brand'

  /**
   * Mount point for the shared agent setup dialog.
   *
   * Rendered once at the app root so every "with agent" control opens the same
   * panel regardless of which view raised it. The mount is conditional, so the
   * dialog seeds itself from the request that opened it and nothing keeps a
   * stale handoff alive after it closes.
   */
  const request = $derived(agentAssist.request)
  const minimized = $derived(
    agentAssistJobs.jobs
      .filter((job) => job.minimized)
      .map((job) => ({
        id: job.id,
        project: '',
        title: job.title,
        status: job.status,
        statusLabel:
          job.status === 'running'
            ? job.detail
            : job.status === 'failed'
              ? 'Failed'
              : job.delivery === 'draft'
                ? 'Prompt ready'
                : 'Agent finished'
      }))
  )
</script>

{#if request}
  <AgentAssistDialog {request} onClose={() => agentAssist.close()} />
{/if}

{#each agentAssistJobs.jobs as job (job.id)}
  <AgentAssistJobPanel {job} />
{/each}
<JobDockRow
  storageKey={`${APP_SLUG}.agentAssistDock.v1`}
  label="Move docked agent assistance runs"
  groupLabel="Docked agent assistance runs"
  jobs={minimized}
  expandLabel={(job) => `Show progress for ${job.title}`}
  onExpand={(id) => agentAssistJobs.expand(id)}
/>
