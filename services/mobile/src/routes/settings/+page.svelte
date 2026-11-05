<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioLogOut from '@pdslng/cio-icon/CioLogOut.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioWindow from '@pdslng/cio-icon/CioWindow.svelte'
  import PanelBar from '#lib/components/PanelBar.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge } from '#lib/api/status'
  import type { Device, DevicePlatform } from '#lib/api/types'
  import { crumbFrom, trailTo } from '#lib/navigation'
  import { session } from '#lib/stores/session.svelte'
  import { syncSystemBars } from '#lib/system-bars'

  /**
   * Settings. It answers what a phone can answer and nothing else: who is signed
   * in here, how the app reads, which devices hold the account, and the way out.
   *
   * The screen is one column of rows under four short headings, and the only
   * explanation it offers is the second line of a row. It is not a place to
   * describe the product, so a row that cannot say something useful says nothing.
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
    // The platform draws form controls and scrollbars from this, and the system
    // bars read it through syncSystemBars.
    root.style.colorScheme = choice === 'system' ? 'light dark' : choice
  }

  function setTheme(choice: ThemeChoice): void {
    theme = choice
    try {
      globalThis.localStorage?.setItem(THEME_KEY, choice)
    } catch {
      // A phone with no storage still changes for this session.
    }
    applyTheme(choice)
    void syncSystemBars()
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

<PanelBar title="Settings" {trail}>
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
