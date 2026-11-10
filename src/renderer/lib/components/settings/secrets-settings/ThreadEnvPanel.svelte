<script lang="ts">
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { formatDateTimeCompact } from '$shared/date-time-format'
  import type { ProjectEnvEntry } from '$shared/project-env'
  import { onMount } from 'svelte'
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte'
  import EnvKeyModal from './EnvKeyModal.svelte'

  /**
   * One thread's own env entries.
   *
   * A thread entry wins over every project file for a process started in that
   * thread, which is how a single conversation gets its own credentials without
   * touching the project's shared values.
   */
  interface Props {
    threadId: string
  }

  let { threadId }: Props = $props()

  let entries = $state<ProjectEnvEntry[]>([])
  let loading = $state(true)
  let busy = $state(false)
  let error = $state('')
  let keyTarget = $state<{ existing: { name: string } | null } | null>(null)
  let deleteName = $state<string | null>(null)

  function report(cause: unknown, fallback: string): void {
    error = cause instanceof Error ? cause.message : fallback
  }

  async function load(): Promise<void> {
    loading = true
    try {
      entries = await invoke('secrets:envThreadList', threadId)
    } catch (cause) {
      report(cause, 'Could not read this thread’s env keys')
    } finally {
      loading = false
    }
  }

  async function saveValue(input: { name: string; value: string }): Promise<void> {
    busy = true
    error = ''
    try {
      entries = await invoke('secrets:envSetThreadValue', {
        threadId,
        name: input.name,
        value: input.value
      })
      keyTarget = null
    } catch (cause) {
      report(cause, 'Could not store this value')
    } finally {
      busy = false
    }
  }

  async function removeEntry(): Promise<void> {
    const name = deleteName
    if (!name) return
    busy = true
    error = ''
    try {
      entries = await invoke('secrets:envRemoveThreadEntry', { threadId, name })
      deleteName = null
    } catch (cause) {
      report(cause, 'Could not remove this key')
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void load()
  })
</script>

<section class="border bg-surface" aria-label="This thread's env keys">
  <div class="flex items-center justify-between gap-2 border-b px-4 py-2">
    <div>
      <h2 class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">This thread</h2>
      <p class="mt-0.5 text-[0.6875rem] text-muted">
        These win over every project file for processes started here.
      </p>
    </div>
    <button
      type="button"
      class="flex h-7 items-center gap-1.5 bg-primary px-2 text-xs font-medium text-on-primary disabled:opacity-40"
      disabled={busy}
      title="Add a key for this thread"
      onclick={() => (keyTarget = { existing: null })}
    >
      <CioPlus size={12} /> Key
    </button>
  </div>

  {#if error}
    <p class="px-4 py-2 text-[0.6875rem] text-danger" role="alert">{error}</p>
  {/if}

  {#if loading}
    <div class="flex items-center gap-2 px-4 py-3 text-xs text-muted">
      <CioSpinner size={14} class="animate-spin" /> Reading keys...
    </div>
  {:else if entries.length === 0}
    <p class="px-4 py-3 text-xs text-muted">No thread keys. The project's own files apply.</p>
  {:else}
    <div class="divide-y">
      {#each entries as entry (entry.name)}
        <div class="flex items-start gap-3 px-4 py-2.5">
          <div class="min-w-0 flex-1">
            <p class="truncate font-mono text-xs text-foreground" title={entry.name}>
              {entry.name}
            </p>
            <p class="mt-0.5 text-[0.6875rem] text-dimmed tabular-nums">
              Updated {formatDateTimeCompact(entry.updatedAt)}
              {#if entry.missing}
                <span class="text-danger">Value is gone, set it again</span>
              {/if}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="h-7 border px-2 text-xs text-muted hover:bg-elevated hover:text-foreground"
              disabled={busy}
              title="Replace the value of {entry.name}"
              onclick={() => (keyTarget = { existing: { name: entry.name } })}
            >
              Replace
            </button>
            <button
              type="button"
              class="h-7 border px-2 text-xs text-danger hover:bg-danger/10"
              disabled={busy}
              title="Delete {entry.name} from this thread"
              onclick={() => (deleteName = entry.name)}
            >
              Delete
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

{#if keyTarget}
  <EnvKeyModal
    existing={keyTarget.existing}
    group=""
    mode="local"
    description="Saved for this thread only. It overrides the project's keys for processes started here."
    {busy}
    {error}
    onSubmit={saveValue}
    onClose={() => {
      if (!busy) keyTarget = null
    }}
  />
{/if}

<ConfirmDialog
  open={deleteName !== null}
  title="Delete this thread key?"
  confirmLabel="Delete key"
  note="The value is removed from the vault and cannot be recovered."
  {busy}
  onCancel={() => (deleteName = null)}
  onConfirm={removeEntry}
>
  <p>
    <span class="font-mono text-foreground">{deleteName ?? ''}</span> stops applying to this thread.
  </p>
</ConfirmDialog>
