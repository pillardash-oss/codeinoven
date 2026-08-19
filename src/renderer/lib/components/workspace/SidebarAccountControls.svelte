<script lang="ts">
  import {
    AlertCircle,
    CheckCircle2,
    Clock,
    Download,
    Info,
    Loader2,
    RefreshCw,
    Settings,
    Smartphone
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { preloadSettingsChunk } from '$lib/page-preload'
  import { updaterState } from '$lib/stores/updater.svelte'
  import type { MainView } from '$lib/stores/renderer-recovery.svelte'
  import type { AccountProfileState } from '$shared/types'

  interface Props {
    active: boolean
    navigate: (view: MainView) => void
  }

  let { active, navigate }: Props = $props()

  async function getRemoteStatus() {
    return invoke('remote:getStatus')
  }

  type RemoteStatus = Awaited<ReturnType<typeof getRemoteStatus>>

  let accountState = $state<AccountProfileState>({ status: 'signed-out', profile: null })
  let remoteStatus = $state<RemoteStatus | null>(null)
  let wasActive: boolean | null = null

  const profile = $derived(accountState.profile)
  const initials = $derived.by(() => {
    const source = profile?.displayName || profile?.email || ''
    return source
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
  })
  const enrolled = $derived(Boolean(remoteStatus?.cloud.desktopId))
  const connectedDevice = $derived(remoteStatus?.devices.find((device) => device.connected) ?? null)
  const remoteReady = $derived(
    Boolean(remoteStatus?.gateway.listening || remoteStatus?.cloud.state === 'online')
  )
  const remoteTitle = $derived(
    connectedDevice
      ? `${connectedDevice.name} connected via ${connectedDevice.transport === 'lan' ? 'LAN' : 'internet'}`
      : remoteReady
        ? 'Mobile access ready'
        : 'Mobile access unavailable'
  )

  async function refreshFooterState(): Promise<void> {
    const [accountResult, remoteResult] = await Promise.allSettled([
      invoke('account:getProfile'),
      getRemoteStatus()
    ])
    if (accountResult.status === 'fulfilled') accountState = accountResult.value
    if (remoteResult.status === 'fulfilled') remoteStatus = remoteResult.value
  }

  $effect(() => {
    const nowActive = active
    if (wasActive === null || (nowActive && !wasActive)) void refreshFooterState()
    wasActive = nowActive
  })

  $effect(() => {
    return subscribe('remote:status', (status) => {
      remoteStatus = status
    })
  })

  $effect(() => {
    return subscribe('account:profileChanged', (state) => {
      accountState = state
    })
  })
</script>

<div class="flex items-center gap-1 px-2 py-1.5">
  {#if profile}
    <button
      type="button"
      class="flex h-8 min-w-0 flex-1 shrink-0 items-center gap-2 overflow-hidden rounded-lg pr-2 transition-colors hover:bg-elevated"
      title="Open {profile.displayName || profile.email}'s profile"
      aria-label="Open {profile.displayName || profile.email}'s profile"
      onmouseenter={preloadSettingsChunk}
      onclick={() => navigate('settings-profile')}
    >
      <span
        class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary text-[10px] font-bold text-on-primary ring-1 ring-border"
      >
        {#if profile.image}
          <img class="h-full w-full object-cover" src={profile.image} alt="" />
        {:else}
          <span aria-hidden="true">{initials}</span>
        {/if}
      </span>
      <span class="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-foreground">
        {profile.displayName || profile.email}
      </span>
    </button>

    {#if enrolled}
      <button
        type="button"
        class="relative flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title={remoteTitle}
        aria-label={`${remoteTitle}. Open remote connection`}
        onmouseenter={preloadSettingsChunk}
        onclick={() => navigate('settings-remote')}
      >
        <Smartphone size={15} />
        <span
          class="absolute right-1 top-1 h-2 w-2 rounded-full border-2 border-surface {connectedDevice
            ? 'bg-success'
            : remoteReady
              ? 'bg-primary'
              : 'bg-danger'}"
          aria-hidden="true"
        ></span>
      </button>
    {/if}
  {:else}
    <button
      type="button"
      class="flex h-8 flex-1 items-center gap-2 rounded-lg px-2 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Open settings (⌘,)"
      onmouseenter={preloadSettingsChunk}
      onclick={() => navigate('settings')}
    >
      <Settings size={14} />
      Settings
    </button>
  {/if}

  <div class="ml-auto flex shrink-0 items-center gap-1">
    {#if profile}
      <button
        type="button"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Open settings (⌘,)"
        aria-label="Open settings"
        onmouseenter={preloadSettingsChunk}
        onclick={() => navigate('settings')}
      >
        <Settings size={15} />
      </button>
    {/if}
    {#if !updaterState.status.canAutoUpdate}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Application and update information"
        aria-label="Open application and update information"
        onmouseenter={preloadSettingsChunk}
        onclick={() => navigate('settings-about')}
      >
        <Info size={14} />
      </button>
    {:else if updaterState.status.state === 'checking'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-dimmed"
        disabled
        title="Checking for updates"
        aria-label="Checking for updates"
      >
        <Loader2 size={14} class="animate-spin" />
      </button>
    {:else if updaterState.status.state === 'available'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-primary transition-colors hover:bg-elevated"
        title="Update {updaterState.status.availableVersion} available — download"
        aria-label="Download update {updaterState.status.availableVersion}"
        onclick={() => void updaterState.downloadUpdate()}
      >
        <Download size={14} />
      </button>
    {:else if updaterState.status.state === 'downloading'}
      <button
        type="button"
        class="flex h-8 items-center gap-1 rounded-lg px-1.5 text-[11px] text-muted"
        disabled
        title="Downloading update — {updaterState.status.downloadProgress}%"
        aria-label="Downloading update — {updaterState.status.downloadProgress}%"
      >
        <Loader2 size={13} class="animate-spin" />
        <span class="tabular-nums">{updaterState.status.downloadProgress}%</span>
      </button>
    {:else if updaterState.status.state === 'downloaded'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-primary transition-colors hover:bg-elevated"
        title="Update ready — restart and install"
        aria-label="Restart and install update"
        onclick={() => void updaterState.installUpdate()}
      >
        <RefreshCw size={14} />
      </button>
    {:else if updaterState.status.state === 'waiting'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-accent"
        disabled
        title="Waiting for {updaterState.waitingForThreads} active thread{updaterState.waitingForThreads !==
        1
          ? 's'
          : ''} to finish"
        aria-label="Update waiting for active threads to finish"
      >
        <Clock size={14} />
      </button>
    {:else if updaterState.status.state === 'error'}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-danger transition-colors hover:bg-elevated"
        title="Update error: {updaterState.status.errorMessage}"
        aria-label="Open update error details"
        onmouseenter={preloadSettingsChunk}
        onclick={() => navigate('settings-about')}
      >
        <AlertCircle size={14} />
      </button>
    {:else}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Application is up to date"
        aria-label="Open application and update information"
        onmouseenter={preloadSettingsChunk}
        onclick={() => navigate('settings-about')}
      >
        <CheckCircle2 size={14} />
      </button>
    {/if}
  </div>
</div>
