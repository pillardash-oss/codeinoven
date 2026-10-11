<script lang="ts">
  import { ExternalLink, Loader2, TriangleAlert } from '@lucide/svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { githubNotifications } from '$lib/stores/github-notifications.svelte'

  /**
   * The token the notifications view runs on.
   *
   * GitHub serves its notification endpoints to a classic personal access token
   * only: its own REST reference marks every one of them as unavailable to GitHub
   * App tokens, which is what the app signs in with everywhere else. A sign-in
   * control here would therefore be a dead end, so this offers the one thing that
   * does work, and makes it a link as much as a button: the create control
   * declares the page it opens, so right-click offers the app's browser, the
   * default browser, or the address itself.
   */
  interface Props {
    open: boolean
    onClose: () => void
  }

  let { open, onClose }: Props = $props()

  let token = $state('')
  let error = $state<string | null>(null)
  let saving = $state(false)
  let confirmingDisconnect = $state(false)

  const status = $derived(githubNotifications.token)
  const createUrl = $derived(status?.createTokenUrl ?? '')
  const connected = $derived(status?.connected === true)
  const canSave = $derived(token.trim().length > 0 && !saving)

  /** Close, dropping the draft and any failure from the attempt that just ended. */
  function close(): void {
    token = ''
    error = null
    saving = false
    onClose()
  }

  async function save(): Promise<void> {
    if (!canSave) return
    saving = true
    error = null
    try {
      await githubNotifications.connectToken(token.trim())
      close()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'That token could not be connected'
    } finally {
      saving = false
    }
  }

  async function disconnect(): Promise<void> {
    try {
      await githubNotifications.disconnectToken()
    } finally {
      confirmingDisconnect = false
    }
  }
</script>

<Modal {open} title="GitHub notifications token" size="md" onClose={close}>
  <div class="space-y-4">
    <p class="text-xs leading-relaxed text-muted">
      GitHub gives its notifications to a personal access token, and refuses the account sign-in the
      rest of this panel uses. Connect a token here and this view reads and acts on your
      notifications with it. It is stored in this device's secure vault and never leaves it.
    </p>

    <button
      type="button"
      class="inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[0.6875rem] font-medium transition-colors hover:bg-elevated"
      title="Create a GitHub token with the notifications scope"
      aria-label="Create a GitHub token with the notifications scope"
      data-external-url={createUrl}
      onclick={() => void openInBrowser(createUrl)}
    >
      <ExternalLink size={13} aria-hidden="true" />
      Create a token on GitHub
    </button>

    {#if connected}
      <div class="flex items-center justify-between gap-3 rounded-lg border bg-surface px-3 py-2">
        <p class="min-w-0 text-xs text-muted">
          Connected as
          <span class="font-medium text-foreground">@{status?.login ?? 'your account'}</span>
          {#if status?.scopes?.length}
            <span class="text-dimmed">({status.scopes.join(', ')})</span>
          {/if}
        </p>
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[0.6875rem] font-medium text-danger transition-colors hover:bg-elevated"
          title="Forget the notification token stored on this device"
          aria-label="Forget the notification token stored on this device"
          onclick={() => (confirmingDisconnect = true)}
        >
          Forget token
        </button>
      </div>
    {/if}

    <label class="block text-xs font-medium text-muted" for="github-notification-token">
      {connected ? 'Replace the token' : 'Token'}
      <input
        id="github-notification-token"
        class="mt-1 w-full rounded-lg border bg-elevated px-3 py-2.5 font-mono text-xs outline-none focus:border-primary"
        type="password"
        placeholder="ghp_…"
        autocomplete="off"
        spellcheck="false"
        bind:value={token}
      />
    </label>

    {#if error}
      <p class="flex items-start gap-1.5 text-[0.6875rem] text-danger" role="alert">
        <TriangleAlert size={12} class="mt-0.5 shrink-0" aria-hidden="true" />
        {error}
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <button type="button" class="rounded-lg border px-3 py-1.5 text-sm" onclick={close}>
      Close
    </button>
    <button
      type="button"
      class="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={!canSave}
      data-modal-primary
      onclick={() => void save()}
    >
      {#if saving}
        <Loader2 size={13} class="mr-1 inline animate-spin" aria-hidden="true" />
      {/if}
      {connected ? 'Replace token' : 'Connect token'}
    </button>
  {/snippet}
</Modal>

<ConfirmDialog
  open={confirmingDisconnect}
  title="Forget the notification token?"
  confirmLabel="Forget token"
  variant="danger"
  busy={githubNotifications.tokenBusy}
  onCancel={() => (confirmingDisconnect = false)}
  onConfirm={disconnect}
>
  Your GitHub notifications are untouched. This device simply stops reading them until a token is
  connected again.
</ConfirmDialog>
