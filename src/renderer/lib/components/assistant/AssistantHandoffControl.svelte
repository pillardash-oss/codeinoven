<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import { Send } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ContinueInProjectModal from '$lib/components/threads/ContinueInProjectModal.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import { isThreadBusy, type Project, type Thread } from '$shared/types'

  interface Props {
    task: Thread
    /** Called after the fork lands, so the workspace can open the new thread. */
    onHandedOff: (forked: Thread) => void
  }

  let { task, onHandedOff }: Props = $props()
  let projects = $state<Project[]>([])
  const projectIcons = new SvelteMap<string, string>()

  let pickerOpen = $state(false)
  let confirmOpen = $state(false)
  let busy = $state(false)

  async function loadProjects(): Promise<void> {
    try {
      const all = await invoke('project:list')
      projects = all.filter((project) => !project.hidden)
    } catch (error) {
      reportError(error, 'Could not load projects')
    }
  }

  function requestHandoff(): void {
    // Handing off mid-run risks write contention on the thread, so it always
    // passes a confirmation gate first (destructive-action rule).
    if (isThreadBusy(task)) {
      confirmOpen = true
      return
    }
    void beginPick()
  }

  async function beginPick(): Promise<void> {
    if (projects.length === 0) await loadProjects()
    pickerOpen = true
  }

  function confirmHandoff(): void {
    confirmOpen = false
    void beginPick()
  }

  function buildSummary(): string {
    const routine = assistantRoutines.routineForTask(task)
    const lines = [
      `Handed off from Assistant View on ${new Date().toLocaleString()}.`,
      `Task: ${task.title}`
    ]
    if (routine) lines.push(`Routine: ${routine.name}`)
    const howTo = routine?.howTo?.trim()
    if (howTo) lines.push('', 'How-to:', howTo)
    const lastRun = task.lastRunAt
    if (lastRun !== undefined) {
      lines.push('', `Last scheduled run: ${new Date(lastRun).toLocaleString()}`)
    }
    return lines.join('\n')
  }

  async function continueInProject(project: Project): Promise<void> {
    if (busy) return
    busy = true
    try {
      const forked = await invoke(
        'thread:fork',
        task.projectId,
        task.id,
        task.title,
        undefined,
        undefined,
        project.id
      )
      // Seed the fork with a context summary so work continues with the full
      // picture. The original task thread and its schedule stay intact.
      try {
        await invoke('history:append', forked.projectId, forked.id, 'system', buildSummary())
      } catch {
        // The summary is additive context; a failed seed must not lose the fork.
      }
      pickerOpen = false
      onHandedOff(forked)
    } catch (error) {
      reportError(error, 'The task could not be handed off to the project')
    } finally {
      busy = false
    }
  }
</script>

<button
  type="button"
  class="flex w-full items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-left text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
  title="Hand this task off to a project"
  aria-label="Hand this task off to a project"
  onclick={requestHandoff}
>
  <Send size={13} strokeWidth={1.8} />
  <span>Hand off to project</span>
</button>

<Modal open={confirmOpen} title="Hand off while running?" onClose={() => (confirmOpen = false)}>
  <p class="text-[0.75rem] text-muted">
    This task is running right now. Handing it off forks the thread into a project while the run
    is still writing to it. Continue anyway?
  </p>
  {#snippet footer()}
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="rounded-md px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        onclick={() => (confirmOpen = false)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-md bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover"
        onclick={confirmHandoff}
      >
        Continue
      </button>
    </div>
  {/snippet}
</Modal>

<ContinueInProjectModal
  open={pickerOpen}
  {projects}
  {projectIcons}
  {busy}
  onClose={() => {
    if (busy) return
    pickerOpen = false
  }}
  onContinue={(project) => continueInProject(project)}
  onProjectCreated={async (project) => {
    projects = [...projects, project]
  }}
/>
