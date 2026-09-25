<script lang="ts">
  import { BrainCircuit } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  interface Props {
    message: string
    projectId: string
    threadId: string
    closeToast?: () => void
  }

  let { message, projectId, threadId, closeToast }: Props = $props()

  let opening = $state(false)

  /**
   * The sidebar only renders the tabs of the *active* project context, and that
   * context becomes active when one of its threads is opened. A proposal can be
   * raised by a thread the user has since left, so Review has to open that
   * thread first, otherwise the memory panel it docks is never the visible one.
   * The notification open hook is reused so the current view is preserved the
   * same way an 'Open thread' notification preserves it.
   */
  async function revealSourceThread(): Promise<void> {
    const selected = workspaceState.selectedThread
    if (selected?.projectId === projectId && selected.id === threadId) return
    const [project, thread] = await Promise.all([
      invoke('project:get', projectId),
      invoke('thread:get', projectId, threadId)
    ])
    if (!thread) return
    const openFromNotification = workspaceState.openThreadFromNotification
    if (project && openFromNotification) {
      await openFromNotification(thread, project)
      return
    }
    workspaceState.openThread(thread, project)
  }

  async function view(): Promise<void> {
    if (opening) return
    opening = true
    try {
      await revealSourceThread()
    } catch {
      // A deleted thread or a failed lookup must not dead-end the button: the
      // panel still opens for the project the proposal came from.
    }
    contextSidebarState.openMemory(projectId, threadId, 'proposed')
    closeToast?.()
  }
</script>

<div class="flex items-start gap-3 rounded-xl border bg-surface p-3 text-foreground shadow-xl">
  <div class="mt-0.5 shrink-0 text-primary">
    <BrainCircuit size={18} />
  </div>
  <div class="min-w-0 flex-1">
    <p class="text-sm leading-relaxed text-foreground">{message}</p>
    <button
      class="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
      type="button"
      onclick={view}
    >
      <BrainCircuit size={12} />
      Review Memory
    </button>
  </div>
</div>
