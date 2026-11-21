<script lang="ts">
  import { onMount } from 'svelte'
  import type { CodeInOvenAccountStatus } from '$shared/ipc/codeinoven-account'
  import { invoke } from '$lib/ipc.svelte'
  import { APP_NAME } from '$shared/brand'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

  /**
   * The desktop's account on the CodeInOven service. Signed in, this machine
   * reports in as an Oven, so the phone can see it and queue work for it.
   */
  type Mode = 'sign-in' | 'create'

  const MIN_PASSWORD = 12

  let status = $state<CodeInOvenAccountStatus | null>(null)
  let mode = $state<Mode>('sign-in')
  let apiBase = $state('')
  let email = $state('')
  let password = $state('')
  let name = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)
  let confirmingSignOut = $state(false)

  const canSubmit = $derived(
    !busy &&
      apiBase.trim().length > 0 &&
      email.includes('@') &&
      (mode === 'sign-in'
        ? password.length > 0
        : password.length >= MIN_PASSWORD && name.trim().length > 0)
  )
  const heartbeatLine = $derived(
    status?.lastHeartbeatAt
      ? `Reported in at ${new Date(status.lastHeartbeatAt).toLocaleTimeString()}`
      : 'Waiting for the first report'
  )

  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }

  function failure(cause: unknown): string {
    return cause instanceof Error
      ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      : 'That did not work.'
  }

  async function load(): Promise<void> {
    try {
      status = await invoke('codeinovenAccount:status')
      apiBase = status.apiBase
    } catch (cause) {
      error = failure(cause)
    }
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return
    busy = true
    error = null
    try {
      status = await invoke('codeinovenAccount:signIn', {
        apiBase: apiBase.trim(),
        email: email.trim(),
        password,
        ...(mode === 'create' ? { name: name.trim() } : {})
      })
      password = ''
    } catch (cause) {
      error = failure(cause)
    } finally {
      busy = false
    }
  }

  async function signOut(): Promise<void> {
    busy = true
    try {
      status = await invoke('codeinovenAccount:signOut')
      confirmingSignOut = false
    } catch (cause) {
      error = failure(cause)
    } finally {
      busy = false
    }
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void submit()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    void submit()
  }

  onMount(() => {
    void load()
  })
</script>

<div class="p-6 pb-24">
  <div class="mb-6">
    <h1 class="text-xl font-bold tracking-tight">Account</h1>
    <p class="mt-0.5 text-sm text-muted">
      Sign in to the {APP_NAME} service so this machine shows up on your phone and takes the prompts you
      queue there.
    </p>
  </div>

  {#if status?.signedIn && status.user}
    <div class="space-y-3 border bg-surface p-4">
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">{status.user.name ?? status.user.email}</p>
        <p class="truncate text-xs text-muted">
          {status.user.email}{status.user.emailVerified ? '' : ' · not verified'}
        </p>
        <p class="mt-1 truncate font-mono text-xs text-muted">{status.apiBase}</p>
        <p class="mt-1 text-xs text-muted">{heartbeatLine}</p>
      </div>
      <div class="flex justify-start">
        <button
          class="h-9 border bg-elevated px-3 text-xs font-medium whitespace-nowrap hover:bg-overlay disabled:opacity-50"
          type="button"
          disabled={busy}
          onclick={() => (confirmingSignOut = true)}
        >
          Sign out
        </button>
      </div>
    </div>
  {:else}
    <form class="max-w-md space-y-3 border bg-surface p-4" onsubmit={onSubmit} novalidate>
      {#if mode === 'create'}
        <label class="block space-y-1">
          <span class="text-xs text-muted">Name</span>
          <input
            {@attach focusOnMount}
            class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
            bind:value={name}
            onkeydown={onKeydown}
            autocomplete="name"
          />
        </label>
      {/if}
      <label class="block space-y-1">
        <span class="text-xs text-muted">Email</span>
        {#if mode === 'sign-in'}
          <input
            {@attach focusOnMount}
            class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
            bind:value={email}
            onkeydown={onKeydown}
            type="email"
            autocomplete="email"
            spellcheck="false"
          />
        {:else}
          <input
            class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
            bind:value={email}
            onkeydown={onKeydown}
            type="email"
            autocomplete="email"
            spellcheck="false"
          />
        {/if}
      </label>
      <label class="block space-y-1">
        <span class="text-xs text-muted">
          {mode === 'create' ? `Password, at least ${MIN_PASSWORD} characters` : 'Password'}
        </span>
        <input
          class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
          bind:value={password}
          onkeydown={onKeydown}
          type="password"
          autocomplete={mode === 'create' ? 'new-password' : 'current-password'}
        />
      </label>
      <label class="block space-y-1">
        <span class="text-xs text-muted">Service address</span>
        <input
          class="h-9 w-full border bg-elevated px-3 font-mono text-sm outline-none focus:border-primary"
          bind:value={apiBase}
          onkeydown={onKeydown}
          autocomplete="off"
          spellcheck="false"
        />
      </label>

      {#if error ?? status?.error}
        <p class="text-xs text-danger" role="status">{error ?? status?.error}</p>
      {/if}

      <div class="flex items-center justify-between gap-2 pt-1">
        <button
          class="h-9 border bg-elevated px-3 text-xs font-medium whitespace-nowrap hover:bg-overlay"
          type="button"
          onclick={() => {
            mode = mode === 'sign-in' ? 'create' : 'sign-in'
            error = null
          }}
        >
          {mode === 'sign-in' ? 'Create an account' : 'Sign in instead'}
        </button>
        <button
          class="h-9 bg-primary px-4 text-xs font-medium whitespace-nowrap text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="submit"
          disabled={!canSubmit}
        >
          {busy ? 'Working' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </button>
      </div>
    </form>
  {/if}
</div>

<ConfirmDialog
  open={confirmingSignOut}
  title="Sign this desktop out?"
  confirmLabel="Sign out"
  variant="danger"
  {busy}
  onCancel={() => (confirmingSignOut = false)}
  onConfirm={signOut}
>
  <p>This machine stops reporting in, and your phone can no longer queue work for it.</p>
</ConfirmDialog>
