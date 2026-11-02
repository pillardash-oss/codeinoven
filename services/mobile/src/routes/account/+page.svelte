<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioWindow from '@pdslng/cio-icon/CioWindow.svelte'
  import CioPerson from '@pdslng/cio-icon/CioPerson.svelte'
  import CioSun from '@pdslng/cio-icon/CioSun.svelte'
  import CioLogOut from '@pdslng/cio-icon/CioLogOut.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import AppBar from '#lib/components/AppBar.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge } from '#lib/api/status'
  import type { Device, DevicePlatform } from '#lib/api/types'
  import { session } from '#lib/stores/session.svelte'

  /**
   * The account behind the bottom nav's Account tab. Four cards, because a
   * phone account screen answers four questions: who am I, which devices are
   * signed in, how does this look, and how do I leave.
   */

  const THEME_KEY = 'cio.mobile.theme'
  const PLATFORM_LABELS: Readonly<Record<DevicePlatform, string>> = {
    desktop: 'Desktop',
    ios: 'iOS',
    android: 'Android'
  }

  type ThemeChoice = 'light' | 'dark' | 'system'

  let identityOpen = $state(true)
  let devicesOpen = $state(true)
  let appearanceOpen = $state(true)

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
  let themeLabel = $derived(themeSummary(theme))

  function themeSummary(choice: ThemeChoice): string {
    if (choice === 'dark') return 'Always dark'
    if (choice === 'light') return 'Always light'
    return 'Following the system'
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
    globalThis.localStorage?.setItem(THEME_KEY, choice)
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

<div class="account-page">
  <AppBar title="Account" ruled />

  <div class="account-scroll">
    <article class="card" data-folded={!identityOpen}>
      <div class="card-head">
        <span class="lead plate"><CioPerson size={16} /></span>
        <div class="card-head-text">
          <h2>Identity</h2>
          <span class="sub">{email}</span>
        </div>
        <button
          class="fold"
          type="button"
          aria-expanded={identityOpen}
          aria-label={identityOpen ? 'Fold identity' : 'Unfold identity'}
          title={identityOpen ? 'Fold identity' : 'Unfold identity'}
          onclick={() => (identityOpen = !identityOpen)}
        >
          <CioChevronDown size={16} />
        </button>
      </div>

      <div class="card-body">
        <div class="identity">
          {#if avatarUrl}
            <img class="avatar" src={avatarUrl} alt="" />
          {:else}
            <span class="mark" aria-hidden="true">{initials}</span>
          {/if}
          <div class="identity-text">
            <span class="identity-name">{displayName}</span>
            <span class="identity-mail">{email}</span>
          </div>
        </div>

        {#if editingName}
          <label class="field">
            <span>Name</span>
            <input bind:value={nameDraft} type="text" autocomplete="name" />
          </label>
          <div class="actions-row">
            <button class="btn quiet" type="button" onclick={cancelEdit}>Cancel</button>
            <button class="btn primary" type="button" onclick={saveName} disabled={savingName}>
              {savingName ? 'Saving' : 'Save'}
            </button>
          </div>
        {:else}
          <button class="btn with-icon" type="button" onclick={beginEdit}>
            <CioPencil size={14} />
            Edit name
          </button>
        {/if}

        {#if identityError}
          <p class="note" role="status">{identityError}</p>
        {/if}

        <div class="run"><span>Email</span><em>{email}</em></div>
        <div class="run"><span>Member since</span><em>{memberSince}</em></div>

        {#if unverified}
          <p class="note warn">
            <CioAlertCircle size={14} />
            Email not verified
          </p>
        {/if}
      </div>
    </article>

    <article class="card" data-folded={!devicesOpen}>
      <div class="card-head">
        <span class="lead plate"><CioDisplay size={16} /></span>
        <div class="card-head-text">
          <h2>This device</h2>
          <span class="sub">{deviceLabel}</span>
        </div>
        <button
          class="fold"
          type="button"
          aria-expanded={devicesOpen}
          aria-label={devicesOpen ? 'Fold devices' : 'Unfold devices'}
          title={devicesOpen ? 'Fold devices' : 'Unfold devices'}
          onclick={() => (devicesOpen = !devicesOpen)}
        >
          <CioChevronDown size={16} />
        </button>
      </div>

      <div class="card-body flush">
        {#if devicesLoading}
          <p class="empty">Reading your devices</p>
        {:else}
          {#each devices as device (device.id)}
            {@const DeviceIcon = deviceIcon(device.platform)}
            <div class="row device">
              <span class="mark plain">
                <DeviceIcon size={16} />
              </span>
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
            <p class="empty">No devices are signed in.</p>
          {/if}
        {/if}

        {#if devicesError}
          <p class="note" role="status">{devicesError}</p>
          <div class="card-foot">
            <div class="right">
              <button class="btn" type="button" onclick={loadDevices}>Retry</button>
            </div>
          </div>
        {/if}
      </div>
    </article>

    <article class="card" data-folded={!appearanceOpen}>
      <div class="card-head">
        <span class="lead plate"><CioSun size={16} /></span>
        <div class="card-head-text">
          <h2>Appearance</h2>
          <span class="sub">{themeLabel}</span>
        </div>
        <button
          class="fold"
          type="button"
          aria-expanded={appearanceOpen}
          aria-label={appearanceOpen ? 'Fold appearance' : 'Unfold appearance'}
          title={appearanceOpen ? 'Fold appearance' : 'Unfold appearance'}
          onclick={() => (appearanceOpen = !appearanceOpen)}
        >
          <CioChevronDown size={16} />
        </button>
      </div>

      <div class="card-body flush">
        <div class="sw-row">
          <span class="sw-label">
            Match the system
            <span class="sw-sub">Use whatever the phone is set to</span>
          </span>
          <button
            class="sw"
            type="button"
            role="switch"
            aria-checked={theme === 'system'}
            aria-label="Match the system appearance"
            title="Match the system appearance"
            onclick={() => setTheme(theme === 'system' ? 'light' : 'system')}
          ></button>
        </div>
        <div class="sw-row">
          <span class="sw-label">
            Dark
            <span class="sw-sub">Always dark, whatever the phone does</span>
          </span>
          <button
            class="sw"
            type="button"
            role="switch"
            aria-checked={theme === 'dark'}
            aria-label="Dark appearance"
            title="Dark appearance"
            onclick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          ></button>
        </div>
      </div>
    </article>

    <article class="card">
      <div class="card-head">
        <span class="lead plate"><CioLogOut size={16} /></span>
        <div class="card-head-text">
          <h2>Sign out</h2>
          <span class="sub">The oven keeps working without this phone</span>
        </div>
      </div>

      {#if confirmingSignOut}
        <div class="confirm">
          <button class="btn quiet" type="button" onclick={() => (confirmingSignOut = false)}>
            Cancel
          </button>
          <span>Sign this device out?</span>
          <button class="btn primary" type="button" onclick={signOut}>Sign out</button>
        </div>
      {:else}
        <div class="card-foot">
          <button class="btn quiet" type="button" onclick={() => (confirmingSignOut = true)}>
            Sign out
          </button>
        </div>
      {/if}
    </article>
  </div>
</div>

<style>
  .account-page {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    height: 100%;
    min-height: 0;
  }

  .account-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.5rem var(--gutter) 1rem;
  }

  /* A card head carries an icon plate, then the name, then the fold. The plate
     is fixed so the two text lines keep the head's free width. */
  .card-head .lead.plate {
    flex: none;
    width: 1.75rem;
    height: 1.75rem;
    display: grid;
    place-items: center;
    background: var(--color-elevated);
    color: var(--color-muted);
  }

  .identity {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .avatar {
    flex: none;
    width: var(--mark);
    height: var(--mark);
    object-fit: cover;
  }

  .identity-text {
    min-width: 0;
  }

  .identity-name {
    display: block;
    font-size: 0.9375rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .identity-mail {
    display: block;
    font-size: 0.75rem;
    color: var(--color-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-body .field {
    padding: 0;
  }

  .card-body .note {
    margin: 0.5rem 0 0;
  }

  /* The first reading in a body has nothing above it to carry the rule. */
  .card-body .run {
    border-top: 1px solid var(--color-border);
  }

  .note.warn :global(svg) {
    color: var(--color-warning);
  }

  .btn.with-icon {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .actions-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  /* The device rows are read, not navigated, so they keep no pointer cursor. */
  .row.device {
    cursor: default;
  }

  .row.device .btn {
    flex: none;
    padding: 0 0.5rem;
  }

  /* The list owns its own edges: the card's body is flush so a row's own
     gutter lines up with the head's. */
  .card-body.flush {
    padding: 0;
  }

  .card-body.flush .note {
    margin: 0.5rem 0.75rem 0.75rem;
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sw-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-height: 3rem;
    padding: 0.5rem 0.75rem;
  }

  .sw-row + .sw-row {
    border-top: 1px solid var(--color-border);
  }

  .sw-label {
    min-width: 0;
    font-size: 0.875rem;
  }

  .sw-sub {
    display: block;
    margin-top: 0.125rem;
    font-size: 0.75rem;
    color: var(--color-muted);
  }
</style>
