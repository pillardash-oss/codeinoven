<script lang="ts">
  import { Loader2, Terminal } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import WorkingThreadList from '$lib/components/shared/WorkingThreadList.svelte'
  import { updateBlockers } from '$lib/stores/update-blockers.svelte'
  import type { UpdateBlockers } from '$shared/ipc-contract'

  interface Props {
    /** Null while the modal is closed. */
    payload: UpdateBlockers | null
    onDismiss: () => void
  }

  let { payload, onDismiss }: Props = $props()

  const VISIBLE_TERMINALS = 6

  let hasThreads = $derived((payload?.projects.length ?? 0) > 0)
  let terminals = $derived(payload?.terminals ?? [])
  let visibleTerminals = $derived(terminals.slice(0, VISIBLE_TERMINALS))
  let remainingTerminalCount = $derived(Math.max(0, terminals.length - VISIBLE_TERMINALS))
  let hasTerminals = $derived(terminals.length > 0)
  let hasListings = $derived(hasThreads || hasTerminals)
  let forcing = $derived(updateBlockers.forcing)

  /**
   * What stopping this costs, in the order the sections above list it.
   *
   * Unlike the close gate, nothing here pauses instead of stopping: a thread
   * interrupted mid-turn comes back as a failed turn to retry, and a shell is
   * closed for good. So there is deliberately no "it continues later" branch
   * here for the copy to make.
   */
  let costs = $derived.by(() => {
    const parts: string[] = []
    if (hasThreads) parts.push('working threads stop mid-turn')
    if (hasTerminals) parts.push('running terminals close')
    if (parts.length === 0) return ''
    return `${parts.length === 1 ? parts[0] : parts.join(' and ')}.`
  })

  let restartSentence = $derived(
    payload?.version ? `The app restarts to apply version ${payload.version}.` : 'The app restarts.'
  )

  /**
   * The one case where the lists and the gate disagree is worth saying out loud.
   *
   * The count comes from live session state and the lists from thread rows and
   * pty handles, so they can differ while a status settles. A non-zero count with
   * nothing listed means the app is waiting on a session it cannot name, which is
   * exactly what the force install is for and would otherwise read as a modal
   * about nothing.
   */
  let unnamedSentence = $derived(
    !hasListings && (payload?.activeCount ?? 0) > 0
      ? `The update is waiting on ${payload?.activeCount} session${
          payload?.activeCount === 1 ? '' : 's'
        } with no thread or terminal to show.`
      : ''
  )
</script>

<Modal open={payload !== null} title="Update waiting on active work" size="lg" onClose={onDismiss}>
  {#if payload}
    <div class="space-y-4">
      {#if hasThreads}
        <WorkingThreadList projects={payload.projects} />
      {/if}

      {#if hasTerminals}
        <div class="space-y-2">
          <p class="text-sm text-muted">These terminals are still running:</p>
          <ul class="space-y-1.5">
            {#each visibleTerminals as terminal (terminal.sessionId)}
              <li class="flex items-center gap-2 text-xs text-muted">
                <Terminal size={13} class="shrink-0 text-dimmed" />
                <span class="shrink-0 font-medium text-foreground">{terminal.shell}</span>
                <span class="min-w-0 truncate font-mono text-dimmed" title={terminal.cwd}>
                  {terminal.cwd}
                </span>
              </li>
            {/each}
            {#if remainingTerminalCount > 0}
              <li class="pl-5 text-xs text-dimmed">+{remainingTerminalCount} more</li>
            {/if}
          </ul>
        </div>
      {/if}

      {#if unnamedSentence}
        <p class="text-sm text-muted">{unnamedSentence}</p>
      {/if}

      {#if costs}
        <p class="text-sm leading-relaxed text-muted">
          Installing now: {costs.toLowerCase()}
          {restartSentence}
        </p>
      {:else if !unnamedSentence}
        <p class="text-sm leading-relaxed text-muted">{restartSentence}</p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Keep waiting for the active work instead of installing now"
      onclick={onDismiss}
    >
      Keep waiting
    </button>
    <button
      type="button"
      data-modal-primary
      class="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-60"
      title="Stop everything listed above and install the update now"
      disabled={forcing}
      onclick={() => void updateBlockers.forceInstall()}
    >
      {#if forcing}
        <Loader2 size={14} class="animate-spin" />
      {/if}
      <span>{forcing ? 'Stopping work' : 'Stop work & install'}</span>
    </button>
  {/snippet}
</Modal>
