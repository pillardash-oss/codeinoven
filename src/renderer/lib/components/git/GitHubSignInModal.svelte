<script lang="ts">
  import { onDestroy } from 'svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import type { GitHubDeviceCode } from '$shared/types'
  import Modal from '../ui/Modal.svelte'
  import { Check, Copy, ExternalLink, Loader2, Smartphone } from '@lucide/svelte'

  interface Props {
    onClose: () => void
    onConnected: () => void
  }

  let { onClose, onConnected }: Props = $props()

  let device = $state<GitHubDeviceCode | null>(null)
  let phase = $state<'starting' | 'waiting' | 'authorized' | 'expired' | 'error'>('starting')
  let message = $state('')
  let copied = $state(false)
  let polling = $state(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function startFlow(): Promise<void> {
    phase = 'starting'
    const result = await gitState.startGitHubDeviceFlow()
    if (!result) {
      phase = 'error'
      message = gitState.error ?? 'GitHub sign-in could not be started'
      return
    }
    device = result
    phase = 'waiting'
    void poll()
  }

  async function poll(): Promise<void> {
    if (polling || !device) return
    polling = true
    try {
      const result = await gitState.pollGitHubDeviceCode(device.deviceCode)
      if (result.status === 'authorized') {
        phase = 'authorized'
        onConnected()
        return
      }
      if (result.status === 'expired') {
        phase = 'expired'
        return
      }
      if (result.status === 'error') {
        phase = 'error'
        message = result.message
        return
      }
      // Still pending — schedule the next poll after the server-suggested interval.
      timer = setTimeout(() => void poll(), device.interval * 1000)
    } finally {
      polling = false
    }
  }

  async function copyCode(): Promise<void> {
    if (!device) return
    try {
      await navigator.clipboard.writeText(device.userCode)
      copied = true
      setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard may be unavailable; the code is still visible.
    }
  }

  async function openGitHub(): Promise<void> {
    if (device) await openInBrowser(device.verificationUri)
  }

  $effect(() => {
    void startFlow()
  })

  onDestroy(() => {
    if (timer) clearTimeout(timer)
  })
</script>

<Modal open title="Sign in to GitHub" {onClose} size="md">
  {#if phase === 'starting'}
    <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
      <Loader2 size={14} class="animate-spin" />
      Starting sign-in…
    </div>
  {:else if phase === 'waiting' && device}
    <div class="space-y-4">
      <p class="text-xs leading-relaxed text-muted">
        Enter this code on GitHub to connect your account. No password is shared with CodeInOven.
      </p>

      <button
        type="button"
        class="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-elevated px-4 py-3"
        title="Copy code"
        aria-label="Copy device code"
        onclick={() => void copyCode()}
      >
        <span class="font-mono text-3xl font-semibold tracking-[0.2em] text-foreground">
          {device.userCode}
        </span>
        {#if copied}
          <Check size={16} class="text-success" />
        {:else}
          <Copy size={16} class="text-dimmed" />
        {/if}
      </button>

      <div class="rounded-lg border border-border bg-surface px-3 py-2">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Verification page
        </p>
        <p class="mt-0.5 truncate font-mono text-[11px] text-foreground">
          {device.verificationUri}
        </p>
      </div>

      <button
        type="button"
        class="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-primary text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover"
        onclick={() => void openGitHub()}
      >
        <ExternalLink size={13} />
        Open GitHub
      </button>

      <p class="flex items-center justify-center gap-1.5 text-[10px] text-dimmed">
        <Loader2 size={11} class="animate-spin" />
        Waiting for you to authorize… (code expires in {device.expiresIn}s)
      </p>
    </div>
  {:else if phase === 'authorized'}
    <div class="flex flex-col items-center justify-center py-8 text-center">
      <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-success/10">
        <Check size={18} class="text-success" />
      </div>
      <p class="text-xs font-medium text-foreground">Signed in to GitHub</p>
      <p class="mt-1 text-[10px] text-dimmed">
        Pull requests and sync now use your GitHub account.
      </p>
      <button
        type="button"
        class="mt-4 h-8 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
        onclick={onClose}
      >
        Done
      </button>
    </div>
  {:else if phase === 'expired'}
    <div class="flex flex-col items-center justify-center py-8 text-center">
      <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-warning/10">
        <Smartphone size={18} class="text-warning" />
      </div>
      <p class="text-xs font-medium text-foreground">Code expired</p>
      <p class="mt-1 max-w-[30ch] text-[10px] leading-relaxed text-dimmed">
        The sign-in code expired before it was authorized. Try again with a fresh code.
      </p>
      <button
        type="button"
        class="mt-4 h-8 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
        onclick={() => void startFlow()}
      >
        Try again
      </button>
    </div>
  {:else}
    <div class="flex flex-col items-center justify-center py-8 text-center">
      <p class="text-xs font-medium text-danger">Sign-in failed</p>
      {#if message}
        <p class="mt-1 max-w-[34ch] text-[10px] leading-relaxed text-dimmed">{message}</p>
      {/if}
      <button
        type="button"
        class="mt-4 h-8 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
        onclick={() => void startFlow()}
      >
        Try again
      </button>
    </div>
  {/if}
</Modal>
