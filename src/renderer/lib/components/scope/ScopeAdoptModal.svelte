<script lang="ts">
  import { FolderInput, Loader2, TriangleAlert } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import type { AdoptableWorktreeInfo } from '$shared/types'

  interface Props {
    open: boolean
    projectId: string
    bucketId: string
    bucketName: string
    onClose: () => void
    onAdopted?: () => void
  }

  let { open, projectId, bucketId, bucketName, onClose, onAdopted }: Props = $props()

  const componentId = $props.id()
  const inputId = `${componentId}-adopt-path`

  let sourcePath = $state('')
  let preview = $state.raw<AdoptableWorktreeInfo | null>(null)
  let runSetup = $state(false)
  let detecting = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)

  let canSubmit = $derived(preview?.adoptable === true && !busy)

  /** Open the OS file picker and prefill + inspect the chosen folder. */
  async function pickFolder(): Promise<void> {
    const folder = await invoke('dialog:pickFolder')
    if (!folder) return
    sourcePath = folder
    await detect()
  }

  /** Preview what adoption would do before anything is moved. */
  async function detect(): Promise<void> {
    const trimmed = sourcePath.trim()
    if (!trimmed) {
      preview = null
      return
    }
    detecting = true
    error = null
    try {
      preview = await scopeState.detectAdoptableWorktree(projectId, trimmed)
    } catch (cause) {
      preview = null
      error = cause instanceof Error ? cause.message : 'This path could not be inspected.'
    } finally {
      detecting = false
    }
  }

  async function submit(): Promise<void> {
    if (!preview?.adoptable) return
    busy = true
    error = null
    try {
      await scopeState.adoptWorktree(projectId, bucketId, {
        sourcePath: sourcePath.trim(),
        runSetup
      })
      onAdopted?.()
      onClose()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The worktree could not be adopted.'
    } finally {
      busy = false
    }
  }

  function close(): void {
    sourcePath = ''
    preview = null
    runSetup = false
    detecting = false
    busy = false
    error = null
    onClose()
  }
</script>

<Modal {open} title="Adopt Git Worktree" size="md" onClose={close}>
  <form
    id={`${componentId}-adopt-form`}
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void submit()
    }}
  >
    <p class="text-sm leading-relaxed text-muted">
      Register an existing Git worktree checkout as the managed root of
      <span class="font-medium text-foreground">{bucketName}</span>. The checkout is moved beneath
      this app's config root with <code>git worktree move</code>; its branch and history stay the
      same.
    </p>

    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for={inputId}>Worktree folder</label>
      <div class="flex items-center gap-2">
        <input
          id={inputId}
          class="w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs text-foreground"
          placeholder="/absolute/path/to/existing-worktree"
          bind:value={sourcePath}
          onchange={() => void detect()}
        />
        <button
          type="button"
          class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs text-muted hover:bg-overlay"
          onclick={() => void pickFolder()}
        >
          <FolderInput size={12} />
          Pick folder
        </button>
      </div>
    </div>

    {#if preview}
      {#if preview.adoptable}
        <div class="rounded-lg border bg-overlay p-3 text-xs leading-relaxed text-muted">
          <p>
            Branch <code class="text-foreground">{preview.branch}</code> at
            <code class="text-dimmed">{preview.path}</code>
          </p>
          <p class="mt-1">Ready to adopt into “{bucketName}”.</p>
        </div>
        <Switch bind:checked={runSetup} label="Run setup scripts after adopting">
          <span class="text-xs font-medium text-foreground">Run setup scripts</span>
        </Switch>
      {:else}
        <div
          class="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-warning"
          role="status"
        >
          <TriangleAlert size={13} class="mt-0.5 shrink-0" />
          <span>{preview.reason ?? 'This path cannot be adopted.'}</span>
        </div>
      {/if}
    {/if}

    {#if error}
      <p class="text-xs text-danger" role="alert">{error}</p>
    {/if}
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="mr-auto rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
      onclick={close}
    >
      Cancel
    </button>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg border bg-elevated px-3 py-2 text-sm text-muted hover:bg-overlay disabled:opacity-50"
      disabled={!sourcePath.trim() || detecting || busy}
      onclick={() => void detect()}
    >
      {#if detecting}
        <Loader2 size={13} class="animate-spin" />
      {/if}
      Check
    </button>
    <button
      type="submit"
      form={`${componentId}-adopt-form`}
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      disabled={!canSubmit}
    >
      {busy ? 'Adopting…' : 'Adopt'}
    </button>
  {/snippet}
</Modal>
