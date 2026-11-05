<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioLogOut from '@pdslng/cio-icon/CioLogOut.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioWindow from '@pdslng/cio-icon/CioWindow.svelte'
  import {
    FONT_FAMILY_OPTIONS,
    FONT_WEIGHT_OPTIONS,
    THEME_OPTIONS,
    ZOOM_LEVEL_OPTIONS
  } from '#shared/app-appearance'
  import PanelBar from '#lib/components/PanelBar.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge } from '#lib/api/status'
  import type { Device, DevicePlatform, Oven } from '#lib/api/types'
  import { crumbFrom, trailTo } from '#lib/navigation'
  import { appearance } from '#lib/stores/appearance.svelte'
  import { session } from '#lib/stores/session.svelte'

  /**
   * Settings. It answers what a phone can answer and nothing else: how the app
   * reads, who is signed in here, which machines have reported in, which devices
   * hold the account, and the way out.
   *
   * The appearance rows are the desktop's own table, shared rather than copied, so
   * the two clients cannot drift into different products. A row is its name, the
   * value in force, and the control that changes it; the only explanation a row
   * carries is that value.
   */

  const PLATFORM_LABELS: Readonly<Record<DevicePlatform, string>> = {
    desktop: 'Desktop',
    ios: 'iOS',
    android: 'Android'
  }

  let devices = $state<Device[]>([])
  let devicesLoading = $state(true)
  let devicesError = $state<string | null>(null)
  let revokingId = $state<string | null>(null)
  let confirmDeviceId = $state<string | null>(null)

  let ovens = $state<Oven[]>([])
  let ovensLoading = $state(true)
  let ovensError = $state<string | null>(null)

  let editingName = $state(false)
  let nameDraft = $state('')
  let savingName = $state(false)
  let identityError = $state<string | null>(null)
  let confirmingSignOut = $state(false)

  /**
   * The panel this screen was opened from, so the crumb and the chevron agree. A
   * reload loses the address it came through, and the work list is the panel a
   * phone leads back to when nothing else is known.
   */
  let parent = $derived(
    crumbFrom(page.url.searchParams.get('from')) ?? { label: 'Threads', href: '/threads' }
  )
  let trail = $derived(trailTo(parent))

  let email = $derived(session.user?.email ?? '')
  let displayName = $derived(session.user?.name ?? 'No name yet')
  let avatarUrl = $derived(session.user?.avatarUrl ?? null)
  let unverified = $derived(session.user !== null && session.user.emailVerifiedAt === null)
  let initials = $derived(initialsOf(session.user?.name ?? null, email))
  let accountLine = $derived(unverified ? `${email} · not verified` : email)

  function shortLabel(label: string): string {
    return label.replace(/\s*\(default\)$/, '')
  }

  function initialsOf(name: string | null, address: string): string {
    const source = (name ?? address).trim()
    const parts = source.split(/[\s._@-]+/).filter(Boolean)
    const marks = parts
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
    return marks.length > 0 ? marks : '?'
  }

  function failure(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
  }

  function deviceIcon(platform: DevicePlatform) {
    return platform === 'desktop' ? CioDisplay : CioWindow
  }

  /* ---- Appearance ---- */

  function setFont(event: Event): void {
    const target = event.currentTarget
    if (!(target instanceof HTMLSelectElement)) return
    appearance.set({ fontFamily: target.value })
  }

  function setWeight(event: Event): void {
    const target = event.currentTarget
    if (!(target instanceof HTMLSelectElement)) return
    appearance.set({ fontWeight: Number(target.value) })
  }

  function setZoom(event: Event): void {
    const target = event.currentTarget
    if (!(target instanceof HTMLSelectElement)) return
    appearance.set({ zoomLevel: Number(target.value) })
  }

  function setFontSize(event: Event): void {
    const target = event.currentTarget
    if (!(target instanceof HTMLInputElement)) return
    appearance.set({ appFontSize: Number(target.value) })
  }

  /* ---- Identity ---- */

  function beginEdit(): void {
    nameDraft = session.user?.name ?? ''
    identityError = null
    editingName = true
  }

  function cancelEdit(): void {
    editingName = false
    identityError = null
  }

  async function saveName(): Promise<void> {
    const next = nameDraft.trim()
    if (next.length === 0 || savingName) return
    savingName = true
    identityError = null
    try {
      session.user = await api.updateMe({ name: next })
      editingName = false
    } catch (cause) {
      identityError = failure(cause)
    } finally {
      savingName = false
    }
  }

  /* ---- Ovens ---- */

  async function loadOvens(): Promise<void> {
    ovensLoading = true
    ovensError = null
    try {
      ovens = await api.ovens()
    } catch (cause) {
      ovensError = failure(cause)
    } finally {
      ovensLoading = false
    }
  }

  /* ---- Devices ---- */

  async function loadDevices(): Promise<void> {
    devicesLoading = true
    devicesError = null
    try {
      devices = await api.devices()
    } catch (cause) {
      devicesError = failure(cause)
    } finally {
      devicesLoading = false
    }
  }

  async function revoke(device: Device): Promise<void> {
    if (revokingId !== null) return
    revokingId = device.id
    devicesError = null
    try {
      await api.revokeDevice(device.id)
      confirmDeviceId = null
      if (device.current) {
        await session.signOut()
        await goto('/sign-in')
        return
      }
      devices = devices.filter((entry) => entry.id !== device.id)
    } catch (cause) {
      devicesError = failure(cause)
    } finally {
      revokingId = null
    }
  }

  /* ---- Sign out ---- */

  async function signOut(): Promise<void> {
    await session.signOut()
    await goto('/sign-in')
  }

  function refresh(): void {
    void loadOvens()
    void loadDevices()
  }

  onMount(() => {
    void loadOvens()
    void loadDevices()
  })
</script>

<PanelBar title="Settings" {trail}>
  {#snippet actions()}
    <button
      class="icon-btn"
      type="button"
      aria-label="Refresh ovens and devices"
      title="Refresh ovens and devices"
      onclick={refresh}
    >
      <CioRefresh size={20} />
    </button>
  {/snippet}
</PanelBar>

<div class="list settings">
  <div class="set-row">
    {#if avatarUrl}
      <img class="avatar" src={avatarUrl} alt="" />
    {:else}
      <span class="avatar mark" aria-hidden="true">{initials}</span>
    {/if}
    <span class="body-cell">
      <span class="row-title">{displayName}</span>
      <span class="row-line">{accountLine}</span>
    </span>
    {#if !editingName}
      <button
        class="btn quiet with-icon"
        type="button"
        aria-label="Edit your name"
        title="Edit your name"
        onclick={beginEdit}
      >
        <CioPencil size={14} />
        Edit
      </button>
    {/if}
  </div>

  {#if editingName}
    <div class="set-row field-row">
      <label class="field">
        <span>Name</span>
        <input bind:value={nameDraft} type="text" autocomplete="name" />
      </label>
    </div>
    <div class="set-row actions-row">
      <button class="btn quiet" type="button" onclick={cancelEdit}>Cancel</button>
      <button class="btn primary" type="button" onclick={saveName} disabled={savingName}>
        {savingName ? 'Saving' : 'Save'}
      </button>
    </div>
  {/if}

  {#if identityError}
    <p class="set-note" role="status">{identityError}</p>
  {/if}

  <p class="set-head">Appearance</p>

  <div class="set-row control-row">
    <span class="body-cell"><span class="row-title">Theme</span></span>
    <span class="seg" role="group" aria-label="Theme">
      {#each THEME_OPTIONS as option (option.id)}
        <button
          type="button"
          aria-pressed={appearance.theme === option.id}
          onclick={() => appearance.set({ theme: option.id })}
        >
          {option.label}
        </button>
      {/each}
    </span>
  </div>

  <div class="set-row control-row">
    <span class="body-cell"><span class="row-title">Font</span></span>
    <select class="set-select" value={appearance.fontFamily} aria-label="Font" onchange={setFont}>
      {#each FONT_FAMILY_OPTIONS as option (option.id)}
        <option value={option.id}>{shortLabel(option.label)}</option>
      {/each}
    </select>
  </div>

  <div class="set-row control-row">
    <span class="body-cell"><span class="row-title">Font size</span></span>
    <input
      class="set-range"
      type="range"
      min="12"
      max="18"
      step="1"
      value={appearance.appFontSize}
      aria-label="Font size"
      title="Adjust the base font size"
      oninput={setFontSize}
    />
    <span class="set-reading">{appearance.appFontSize}px</span>
  </div>

  <div class="set-row control-row">
    <span class="body-cell"><span class="row-title">Weight</span></span>
    <select
      class="set-select"
      value={appearance.fontWeight}
      aria-label="Font weight"
      onchange={setWeight}
    >
      {#each FONT_WEIGHT_OPTIONS as option (option.id)}
        <option value={option.id}>{shortLabel(option.label)}</option>
      {/each}
    </select>
  </div>

  <div class="set-row control-row">
    <span class="body-cell"><span class="row-title">Zoom</span></span>
    <select class="set-select" value={appearance.zoomLevel} aria-label="Zoom" onchange={setZoom}>
      {#each ZOOM_LEVEL_OPTIONS as option (option.id)}
        <option value={option.id}>{option.label}</option>
      {/each}
    </select>
  </div>

  <p class="set-head">Ovens</p>

  {#if ovensLoading}
    <div class="set-row">
      <span class="body-cell"><span class="row-line">Checking in with the service</span></span>
    </div>
  {:else}
    {#each ovens as oven (oven.id)}
      <div class="set-row">
        <span class="mark plain device-icon"><CioDisplay size={16} /></span>
        <span class="body-cell">
          <span class="row-title">{oven.name}</span>
          <span class="row-line">Seen {formatAge(oven.lastHeartbeatAt)}</span>
        </span>
      </div>
    {/each}
    {#if ovens.length === 0 && !ovensError}
      <div class="set-row">
        <span class="body-cell"><span class="row-line">No Oven has reported in yet.</span></span>
      </div>
    {/if}
  {/if}

  {#if ovensError}
    <p class="set-note" role="status">{ovensError}</p>
    <div class="set-row actions-row">
      <span></span>
      <button class="btn" type="button" onclick={loadOvens}>Retry</button>
    </div>
  {/if}

  <p class="set-head">Devices</p>

  {#if devicesLoading}
    <div class="set-row">
      <span class="body-cell"><span class="row-line">Reading your devices</span></span>
    </div>
  {:else}
    {#each devices as device (device.id)}
      {@const DeviceIcon = deviceIcon(device.platform)}
      <div class="set-row">
        <span class="mark plain device-icon"><DeviceIcon size={16} /></span>
        <span class="body-cell">
          <span class="row-title">{device.name}</span>
          <span class="row-line">
            {device.current ? 'This device · ' : ''}{PLATFORM_LABELS[device.platform]} · seen
            {formatAge(device.lastSeenAt)}
          </span>
        </span>
        <button class="btn quiet" type="button" onclick={() => (confirmDeviceId = device.id)}>
          Revoke
        </button>
      </div>
      {#if confirmDeviceId === device.id}
        <div class="confirm">
          <button class="btn quiet" type="button" onclick={() => (confirmDeviceId = null)}>
            Cancel
          </button>
          <span>Revoke {device.name}?</span>
          <button
            class="btn primary"
            type="button"
            onclick={() => revoke(device)}
            disabled={revokingId !== null}
          >
            {revokingId === device.id ? 'Revoking' : 'Revoke'}
          </button>
        </div>
      {/if}
    {/each}
    {#if devices.length === 0 && !devicesError}
      <div class="set-row">
        <span class="body-cell"><span class="row-line">No devices are signed in.</span></span>
      </div>
    {/if}
  {/if}

  {#if devicesError}
    <p class="set-note" role="status">{devicesError}</p>
    <div class="set-row actions-row">
      <span></span>
      <button class="btn" type="button" onclick={loadDevices}>Retry</button>
    </div>
  {/if}

  <p class="set-head">Session</p>

  {#if confirmingSignOut}
    <div class="confirm">
      <button class="btn quiet" type="button" onclick={() => (confirmingSignOut = false)}>
        Cancel
      </button>
      <span>Sign this device out?</span>
      <button class="btn primary" type="button" onclick={signOut}>Sign out</button>
    </div>
  {:else}
    <div class="set-row">
      <span class="plate"><CioLogOut size={16} /></span>
      <span class="body-cell">
        <span class="row-title">Sign out</span>
        <span class="row-line">This phone only</span>
      </span>
      <button class="btn quiet" type="button" onclick={() => (confirmingSignOut = true)}>
        Sign out
      </button>
    </div>
  {/if}
</div>
