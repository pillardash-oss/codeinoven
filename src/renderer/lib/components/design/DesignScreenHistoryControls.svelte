<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { designScreenName } from '$shared/design/screens'
  import type { DesignPageHistoryState } from '$shared/ipc-contract'
  import { isThreadBusyStatus } from '$shared/thread-status-policy'
  import DesignHistoryActions from './DesignHistoryActions.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'

  interface Props {
    projectId: string
    threadId: string
    tabId: string
    directory: string
    entry: string
    labelled?: boolean
    active?: boolean
  }
  let {
    projectId,
    threadId,
    tabId,
    directory,
    entry,
    labelled = false,
    active = true
  }: Props = $props()
  let history = $state.raw<DesignPageHistoryState | null>(null)
  let busy = $state(false)
  let error = $state('')
  let pending = $state('')
  let generation = 0
  let alive = true
  const name = $derived(designScreenName(entry))
  const undoStep = $derived(history?.revisions[(history?.cursorIndex ?? 0) - 1])
  const redoStep = $derived(history?.revisions[(history?.cursorIndex ?? -1) + 1])

  async function load(): Promise<void> {
    const token = ++generation
    try {
      const next = await invoke('design:historyPage', projectId, threadId, directory, entry)
      if (alive && token === generation) {
        history = next
        error = ''
      }
    } catch (failure) {
      if (alive && token === generation)
        error = failure instanceof Error ? failure.message : 'Screen history could not be read.'
    }
  }

  async function restore(id: string): Promise<void> {
    if (busy) return
    busy = true
    ++generation
    try {
      const result = await invoke(
        'design:historyRestoreFile',
        projectId,
        threadId,
        directory,
        entry,
        id
      )
      if (!alive) return
      history = result.page
      error = ''
      await invoke('browser:reload', tabId)
    } catch (failure) {
      if (alive)
        error = failure instanceof Error ? failure.message : 'The screen could not be restored.'
    } finally {
      if (alive) busy = false
    }
  }

  function step(direction: 'undo' | 'redo'): void {
    const point = direction === 'undo' ? undoStep : redoStep
    if (!point || busy) return
    if (!point.present) pending = point.revisionId
    else void restore(point.revisionId)
  }

  onMount(() => {
    void load()
    const changed = subscribe('design:historyChanged', (owner, folder) => {
      if (owner === projectId && folder === directory && !busy) void load()
    })
    const shortcuts = subscribe('browser:panelShortcut', (owner, action) => {
      if (owner !== tabId || !active || busy) return
      const focus = document.hasFocus() ? document.activeElement : null
      if (
        focus instanceof HTMLElement &&
        (focus.matches('input, textarea, [contenteditable="true"]') ||
          focus.closest('[role="dialog"]'))
      )
        return
      if (action === 'design-undo' && history?.canUndo) step('undo')
      if (action === 'design-redo' && history?.canRedo) step('redo')
    })
    const settled = subscribe('thread:updated', (thread) => {
      if (
        thread.projectId === projectId &&
        thread.id === threadId &&
        !isThreadBusyStatus(thread.status) &&
        !busy
      )
        void load()
    })
    return () => {
      alive = false
      ++generation
      changed()
      shortcuts()
      settled()
    }
  })
</script>

<DesignHistoryActions
  canUndo={history?.canUndo === true && !busy}
  canRedo={history?.canRedo === true && !busy}
  undoTitle={undoStep?.label
    ? `Undo ${name}: return to ${undoStep.label}`
    : `Undo the last change to ${name}`}
  redoTitle={redoStep?.label
    ? `Redo ${name}: ${redoStep.label}`
    : `Redo the last change to ${name}`}
  {labelled}
  onUndo={() => step('undo')}
  onRedo={() => step('redo')}
/>
{#if error}<span class="max-w-32 truncate text-[0.625rem] text-danger" role="alert" title={error}
    >{error}</span
  >{/if}
<ConfirmDialog
  open={pending !== ''}
  title={`Remove the ${name} screen?`}
  confirmLabel="Restore history point"
  variant="primary"
  onCancel={() => (pending = '')}
  onConfirm={() => {
    const id = pending
    pending = ''
    void restore(id)
  }}
>
  <p>
    This screen did not exist at the selected history point and will be removed. You can restore it
    with Redo.
  </p>
</ConfirmDialog>
