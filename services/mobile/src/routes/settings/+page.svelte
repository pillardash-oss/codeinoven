<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioLogOut from '@pdslng/cio-icon/CioLogOut.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioWindow from '@pdslng/cio-icon/CioWindow.svelte'
  import AppBar from '#lib/components/AppBar.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge } from '#lib/api/status'
  import type { Device, DevicePlatform } from '#lib/api/types'
  import { session } from '#lib/stores/session.svelte'

  /**
   * Settings. The phone answers three questions here and nothing else: how it
   * reads, who this device is signed in as, and which devices still hold the
   * account.
   *
   * A setting is one row. The scheme is one choice out of three, so it is one
   * segmented control: a pair of switches can disagree, and a scheme that can be
   * both "follow the system" and "always dark" has no meaning on a phone.
   */

  const THEME_KEY = 'cio.mobile.theme'
  const PLATFORM_LABELS: Readonly<Record<DevicePlatform, string>> = {
    desktop: 'Desktop',
    ios: 'iOS',
    android: 'Android'
  }

  type ThemeChoice = 'light' | 'dark' | 'system'

  const SCHEMES: readonly { id: ThemeChoice; label: string }[] = [
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
    { id: 'system', label: 'Auto' }
  ]

  let theme = $state<ThemeChoice>('system')

  let devices = $state<Device[]>([])
  let devicesLoading = $state(true)
  let devicesError = $state<string | null>(null)
  let revokingId = $state<string | null>(null)
  let confirmDeviceId = $state<string | null>(null)

  let editingName = $state(false)
  let nameDraft = $state('')
  let savingName = $state(false)
  let identityError = $state<string | null>(null)
  let confirmingSignOut = $state(false)

  let email = $derived(session.user?.email ?? '')
  let displayName = $derived(session.user?.name ?? 'No name yet')
  let avatarUrl = $derived(session.user?.avatarUrl ?? null)
  let unverified = $derived(session.user !== null && session.user.emailVerifiedAt === null)
  let initials = $derived(initialsOf(session.user?.name ?? null, email))
  let memberSince = $derived(session.user ? joinedAge(session.user.createdAt) : '')
  let deviceLabel = $derived(
    session.device
      ? `${session.device.name} · ${PLATFORM_LABELS[session.device.platform]}`
      : 'This phone'
  )

  function themeSummary(choice: ThemeChoice): string {
    if (choice === 'dark') return 'Always dark'
    if (choice === 'light') return 'Always light'
    return 'System default'
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

  function joinedAge(epoch: number): string {
    const age = formatAge(epoch)
    return age === 'now' ? 'Joined today' : `Joined ${age} ago`
  }

  function failure(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
  }

  function deviceIcon(platform: DevicePlatform) {
    return platform === 'desktop' ? CioDisplay : CioWindow
  }

  /* ---- Appearance ---- */

  function applyTheme(choice: ThemeChoice): void {
    const root = document.documentElement
    root.classList.remove('dark', 'light')
    if (choice === 'dark') root.classList.add('dark')
    if (choice === 'light') root.classList.add('light')
  }

  function setTheme(choice: ThemeChoice): void {
    theme = choice
    try {
      globalThis.localStorage?.setItem(THEME_KEY, choice)
    } catch {
      // A phone with no storage still changes for this session.
    }
    applyTheme(choice)
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

  onMount(() => {
    const stored = globalThis.localStorage?.getItem(THEME_KEY)
    theme = stored === 'dark' || stored === 'light' ? stored : 'system'
    applyTheme(theme)
    void loadDevices()
  })
</script>

<AppBar title="Settings">
  {#snippet actions()}
    <button
      class="icon-btn"
      type="button"
      aria-label="Refresh devices"
      title="Refresh devices"
      onclick={loadDevices}
    >
      <CioRefresh size={20} />
    </button>
  {/snippet}
</AppBar>

<div class="list settings">
  <p class="set-head">Appearance</p>

  <div class="set-row">
    <span class="body-cell">
      <span class="row-title">Scheme</span>
      <span class="row-line">{themeSummary(theme)}</span>
    </span>
    <span class="seg" role="group" aria-label="Colour scheme">
      {#each SCHEMES as scheme (scheme.id)}
        <button
          type="button"
          aria-pressed={theme === scheme.id}
          onclick={() => setTheme(scheme.id)}
        >
          {scheme.label}
        </button>
      {/each}
    </span>
  </div>

  <p class="set-head">Account</p>

  <div class="set-row">
    {#if avatarUrl}
      <img class="avatar" src={avatarUrl} alt="" />
    {:else}
      <span class="avatar mark" aria-hidden="true">{initials}</span>
    {/if}
    <span class="body-cell">
      <span class="row-title">{displayName}</span>
      <span class="row-line">{email}</span>
    </span>
    {#if !editingName}
      <button class="btn quiet with-icon" type="button" onclick={beginEdit}>
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

  <div class="set-row">
    <span class="body-cell">
      <span class="row-title">Member since</span>
      <span class="row-line">{memberSince}</span>
    </span>
  </div>

  {#if unverified}
    <div class="set-row">
      <span class="body-cell">
        <span class="row-title">Email not verified</span>
        <span class="row-line">Verify it from the desktop to finish the account</span>
      </span>
      <span class="warn"><CioAlertCircle size={18} /></span>
    </div>
  {/if}

  <p class="set-head">Connection</p>

  <div class="set-row">
    <span class="body-cell">
      <span class="row-title">This device</span>
      <span class="row-line">{deviceLabel}</span>
    </span>
  </div>

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

  <p class="set-head">Sign out</p>

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
      <span class="lead plate"><CioLogOut size={16} /></span>
      <span class="body-cell">
        <span class="row-title">Sign this device out</span>
        <span class="row-line">The oven keeps working without it</span>
      </span>
      <button class="btn quiet" type="button" onclick={() => (confirmingSignOut = true)}>
        Sign out
      </button>
    </div>
  {/if}

  <p class="set-foot">
    The phone has no editor, terminal or browser of its own. Everything here is about how this
    client reaches the desktop and how it reads.
  </p>
</div>

<style>
  .settings {
    padding-bottom: 1.5rem;
  }

  .avatar {
    flex: none;
    width: var(--mark);
    height: var(--mark);
    object-fit: cover;
  }

  .avatar.mark {
    display: grid;
    place-items: center;
    font-size: 0.75rem;
    color: var(--color-muted);
    background: var(--color-elevated);
  }

  .lead.plate,
  .device-icon {
    flex: none;
    width: 1.75rem;
    height: 1.75rem;
    display: grid;
    place-items: center;
    background: var(--color-elevated);
    color: var(--color-muted);
  }

  .device-icon {
    width: 1.5rem;
    height: 1.5rem;
  }

  .set-row .btn {
    flex: none;
    padding: 0 0.625rem;
  }

  .btn.with-icon {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .field-row {
    align-items: stretch;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    color: var(--ink-meta);
  }

  .field input {
    width: 100%;
    min-height: 2.75rem;
    padding: 0 0.625rem;
    border: 1px solid var(--color-border-strong);
    background: var(--color-surface);
    color: var(--color-foreground);
    font: inherit;
    font-size: 0.9375rem;
  }

  .actions-row {
    justify-content: space-between;
  }

  .confirm {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem 0.5rem 0.25rem;
    border-top: 1px solid var(--color-border);
    background: var(--color-elevated);
  }

  .confirm span {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    color: var(--color-muted);
    text-align: center;
  }

  .warn {
    flex: none;
    display: grid;
    place-items: center;
    color: var(--color-warning);
  }

  .set-note {
    margin: 0;
    padding: 0.5rem var(--gutter) 0;
    font-size: 0.75rem;
    color: var(--color-danger);
  }

  .set-foot {
    margin: 0;
    padding: 1.5rem var(--gutter) 2rem;
    font-size: 0.75rem;
    color: var(--ink-meta);
    line-height: 1.5;
  }
</style>
