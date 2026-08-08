<script lang="ts">
  import type { Component } from 'svelte'
  import RemoteClientView from '$lib/components/remote/RemoteClientView.svelte'
  import CloudRemoteAccess from '$lib/components/remote/CloudRemoteAccess.svelte'
  import { remoteSession } from '$lib/remote/session-store.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { applyTheme, resolveTheme, watchSystemDark } from '$lib/theme'

  let { onBack = () => undefined }: { onBack?: () => void } = $props()

  let connected = $derived(
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
      remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
  )

  let hasLanPairing = $derived(
    typeof window !== 'undefined' &&
      (new URLSearchParams(window.location.search).has('pair') ||
        new URLSearchParams(window.location.hash.slice(1)).has('pair'))
  )

  /** The connected shell is loaded lazily so the disconnected entry closure
   *  never includes the mobile workspace graph. */
  let ConnectedShell = $state<Component | null>(null)
  let shellError = $state('')

  $effect(() => {
    if (!connected || ConnectedShell) return
    let active = true
    void import('./RemoteMobileShell.svelte')
      .then((module) => {
        if (active) ConnectedShell = module.default
      })
      .catch((error: unknown) => {
        if (active) {
          shellError =
            error instanceof Error ? error.message : 'The remote workspace could not be loaded.'
        }
      })
    return () => {
      active = false
    }
  })

  // The desktop shell applies the theme from its own root component, which the
  // phone never mounts. Without this the client is stuck in light mode.
  let systemDark = $state(false)
  let preference = $state<'system' | 'light' | 'dark'>('system')

  $effect(() => watchSystemDark((dark) => (systemDark = dark)))

  // The desktop's configured theme only becomes readable once the bridge is
  // live; until then the phone's own colour scheme is the best approximation.
  $effect(() => {
    if (!connected) return
    let active = true
    void invoke('config:get')
      .then((config) => {
        if (active) preference = config.theme
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  })

  $effect(() => applyTheme(resolveTheme(preference, systemDark)))
</script>

{#if connected}
  {#if ConnectedShell}
    {@const Shell = ConnectedShell}
    <Shell onDisconnect={() => remoteSession.disconnect()} />
  {:else if shellError}
    <div
      class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-foreground"
    >
      <p class="text-[15px] font-medium">Could not load the workspace</p>
      <p class="max-w-72 text-[13px] leading-relaxed text-dimmed">{shellError}</p>
    </div>
  {:else}
    <div class="flex h-full items-center justify-center text-foreground">
      <p class="text-[14px] text-muted">Loading workspace…</p>
    </div>
  {/if}
{:else}
  {#if hasLanPairing}
    <RemoteClientView pwa {onBack} />
  {:else}
    <CloudRemoteAccess />
  {/if}
{/if}
