<script lang="ts">
  import { Clock, MessagesSquare } from '@lucide/svelte'
  import type { Thread } from '$shared/types'
  import { isOrchestrationChildThread, isThreadBusy } from '$shared/types'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { statusBadgeForThread } from '$lib/thread-status-badge'
  import CommandPalette from '../actions/CommandPalette.svelte'
  import type { ActionDefinition, ActionSelection } from '$lib/actions'

  interface Props {
    open: boolean
    projectId: string | null
    currentThreadId: string
    /** Threads already selected — hidden/disabled so the user can keep adding. */
    selectedIds?: string[]
    onSelect: (thread: Thread) => void
    onClose: () => void
  }

  let { open, projectId, currentThreadId, selectedIds = [], onSelect, onClose }: Props = $props()

  let threads = $state<Thread[]>([])
  let loading = $state(false)
  let requestId = 0

  function isLiveWorking(thread: Thread): boolean {
    return agentRuns.hasSettled(thread.projectId, thread.id)
      ? agentRuns.isBusy(thread.projectId, thread.id)
      : Boolean(thread.sessionId) && isThreadBusy(thread)
  }

  function isCandidate(thread: Thread): boolean {
    if (thread.id === currentThreadId || thread.archived || isOrchestrationChildThread(thread)) {
      return false
    }
    if (isLiveWorking(thread)) return true
    if (thread.status === 'completed' && !thread.read) return true
    // The picker intentionally includes every non-draft, non-completed state,
    // plus unread completions: working threads and anything needing attention.
    return thread.status !== 'created' && thread.status !== 'completed'
  }

  function stageLabel(thread: Thread): string {
    if (isLiveWorking(thread)) {
      if (thread.status === 'planning') return 'Working · planning'
      return 'Working'
    }
    if (thread.status === 'spec') return 'Spec ready'
    if (thread.status === 'working-paused') return 'Working paused · retry scheduled'
    if (thread.status === 'awaiting_approval') return 'Needs attention · approval'
    if (thread.status === 'failed') return 'Needs attention · error'
    if (thread.status === 'interrupted') return 'Needs attention · interrupted'
    return 'Needs attention'
  }

  $effect(() => {
    if (!open || !projectId) return
    const activeRequest = ++requestId
    loading = true
    void invoke('thread:list', projectId)
      .then((result) => {
        if (activeRequest !== requestId) return
        threads = result.filter(isCandidate).sort((left, right) => {
          const leftWorking = isLiveWorking(left)
          const rightWorking = isLiveWorking(right)
          if (leftWorking !== rightWorking) return leftWorking ? -1 : 1
          return right.lastActivity - left.lastActivity
        })
        loading = false
      })
      .catch(() => {
        if (activeRequest !== requestId) return
        threads = []
        loading = false
      })
  })

  let actions = $derived<ActionDefinition[]>(
    threads.map((thread) => {
      const liveWorking = isLiveWorking(thread)
      const status = statusBadgeForThread(thread, liveWorking)
      return {
        id: `start-after:${thread.id}`,
        title: thread.title,
        description: stageLabel(thread),
        category: 'thread',
        source: {
          id: `project:${thread.projectId}`,
          label: 'This project',
          kind: 'app'
        },
        icon: liveWorking ? MessagesSquare : Clock,
        ...(status ? { status } : {}),
        keywords: [stageLabel(thread), 'working', 'attention', 'start after'],
        disabledReason: selectedIds.includes(thread.id) ? 'Already selected' : undefined
      }
    })
  )

  function selectThread(selection: ActionSelection): void {
    const threadId = selection.action.id.slice('start-after:'.length)
    const thread = threads.find((candidate) => candidate.id === threadId)
    if (thread) onSelect(thread)
  }
</script>

<CommandPalette
  {open}
  {actions}
  title="Start after threads"
  placeholder="Search working or attention threads…"
  emptyLabel={loading ? 'Loading active threads…' : 'No working or attention threads'}
  headerIcon={Clock}
  headerIconBadge
  headerIconBadgeClass="border-info/25 bg-info/10 text-info"
  closeOnSelect={false}
  onSelect={selectThread}
  {onClose}
  shortcutLabel="ESC"
/>
