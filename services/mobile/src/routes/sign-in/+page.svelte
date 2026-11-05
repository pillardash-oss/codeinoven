<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import { Capacitor } from '@capacitor/core'
  import { Browser } from '@capacitor/browser'
  import BrandMark from '#lib/components/BrandMark.svelte'
  import ProviderMark from '#lib/components/ProviderMark.svelte'
  import { api, getApiBase, ApiError } from '#lib/api/client'
  import { session } from '#lib/stores/session.svelte'

  /**
   * The one screen before the app: the mark, the wordmark and the two fields
   * that identify a person. Signing in is the default, because most opens of
   * this screen are a returning user; creating an account adds a name and the
   * twelve character rule the service enforces.
   */
  type Mode = 'sign-in' | 'create'

  const MIN_PASSWORD = 12

  let mode = $state<Mode>('sign-in')
  let email = $state('')
  let password = $state('')
  let name = $state('')
  let localError = $state<string | null>(null)
  /** The first field takes the caret as soon as it exists. */
  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }

  /**
   * Provider sign-in. The phone opens the system browser, the backend completes
   * the OAuth round trip and hands back a one-time code on the app's own deep
   * link, and this screen trades that code for the device's session. In a plain
   * browser the same code arrives as a query parameter on this route.
   */
  let providers = $state<Record<string, boolean>>({})
  /** Until the server answers, a provider button is shown disabled rather than
   *  missing, so the screen does not jump once the answer lands. */
  let providersLoaded = $state(false)
  let showGoogle = $derived(!providersLoaded || providers.google === true)
  let showGithub = $derived(!providersLoaded || providers.github === true)
  let message = $derived(localError ?? session.error)
  let actionLabel = $derived(actionText(mode, session.busy))

  function actionText(current: Mode, busy: boolean): string {
    if (busy) return current === 'create' ? 'Creating account' : 'Signing in'
    return current === 'create' ? 'Create account' : 'Sign in'
  }

  function toggleMode(): void {
    mode = mode === 'sign-in' ? 'create' : 'sign-in'
    localError = null
    session.clearError()
  }

  async function submitNow(): Promise<void> {
    if (session.busy) return
    localError = null
    session.clearError()

    const address = email.trim()
    const person = name.trim()
    if (!address.includes('@')) {
      localError = 'Enter the email address for this account.'
      return
    }
    if (password.length === 0) {
      localError = 'Enter your password.'
      return
    }
    if (mode === 'create' && password.length < MIN_PASSWORD) {
      localError = `A password needs at least ${MIN_PASSWORD} characters.`
      return
    }
    if (mode === 'create' && person.length === 0) {
      localError = 'Enter a name for this account.'
      return
    }

    const accepted =
      mode === 'create'
        ? await session.signUp(person, address, password)
        : await session.signIn(address, password)
    if (accepted) await goto('/')
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void submitNow()
  }

  /** The app's primary action key, in both the command and control dialects. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    if (!event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    void submitNow()
  }

  onMount(() => {
    if (session.signedIn) {
      void goto('/')
      return
    }
    void loadProviders()
  })

  /**
   * A provider callback lands here as `?code=` (or `?error=`), whether the app was
   * launched by the link or already open. This is the only place that spends the
   * code, and it clears it from the address afterwards so a reload cannot replay it.
   */
  $effect(() => {
    const code = page.url.searchParams.get('code')
    const failure = page.url.searchParams.get('error')
    if (session.busy) return
    if (failure) {
      localError = `That sign-in did not finish (${failure}). Try again.`
      void goto('/sign-in', { replaceState: true })
      return
    }
    if (code) {
      void finishOAuth(code).then(() => goto('/sign-in', { replaceState: true }))
    }
  })

  async function loadProviders(): Promise<void> {
    try {
      providers = await api.providers()
    } catch {
      // An unreachable service already explains itself on submit; the provider
      // buttons stay hidden rather than offering a flow that cannot start.
      providers = {}
    } finally {
      providersLoaded = true
    }
  }

  /** The reason a provider button is not pressable yet, or what it will do. */
  function providerTitle(name: 'Google' | 'GitHub', available: boolean): string {
    if (!providersLoaded) return `Checking whether ${name} sign-in is available`
    return available ? `Sign in with ${name}` : `${name} sign-in is not configured on this server`
  }

  async function startProvider(provider: 'google' | 'github'): Promise<void> {
    localError = null
    session.clearError()
    const platform = Capacitor.getPlatform()
    const native = platform === 'ios' || platform === 'android'
    const redirect = native ? 'codeinoven://auth' : globalThis.location.origin
    const url = `${getApiBase()}/v1/auth/${provider}/start?platform=${native ? platform : 'desktop'}&redirect=${encodeURIComponent(redirect)}`
    if (native) {
      await Browser.open({ url })
      return
    }
    globalThis.location.assign(url)
  }

  async function finishOAuth(code: string): Promise<void> {
    let accepted = false
    try {
      accepted = await session.completeOAuth(code)
    } catch (cause) {
      localError =
        cause instanceof ApiError ? cause.message : 'That sign-in did not finish. Try again.'
      return
    }
    if (accepted) await goto('/')
    else localError = session.error ?? 'That sign-in did not finish. Try again.'
  }
</script>

<div class="auth-page">
  <div class="brand">
    <div class="brand-mark"><BrandMark size={56} /></div>
    <p class="wordmark brand-name">CodeInOven</p>
    <p class="brand-line">The desktop's work, in your pocket.</p>
  </div>

  {#if showGoogle || showGithub}
    <div class="providers">
      {#if showGoogle}
        <button
          class="btn provider"
          type="button"
          disabled={session.busy || !providersLoaded || providers.google !== true}
          title={providerTitle('Google', providers.google === true)}
          onclick={() => startProvider('google')}
        >
          <ProviderMark provider="google" />
          <span class="provider-label">Continue with Google</span>
        </button>
      {/if}
      {#if showGithub}
        <button
          class="btn provider"
          type="button"
          disabled={session.busy || !providersLoaded || providers.github !== true}
          title={providerTitle('GitHub', providers.github === true)}
          onclick={() => startProvider('github')}
        >
          <ProviderMark provider="github" />
          <span class="provider-label">Continue with GitHub</span>
        </button>
      {/if}
      <p class="provider-note">New accounts are created on first sign in.</p>
    </div>

    <p class="or"><span>or with email</span></p>
  {/if}

  <form class="card auth" onsubmit={onSubmit} aria-busy={session.busy} novalidate>
    <div class="fields">
      {#if mode === 'create'}
        <label class="field">
          <span>Name</span>
          <input
            bind:value={name}
            onkeydown={onKeydown}
            type="text"
            autocomplete="name"
            autocapitalize="words"
            spellcheck="false"
            placeholder="Ada Lovelace"
          />
        </label>
      {/if}

      <label class="field">
        <span>Email</span>
        <input
          {@attach focusOnMount}
          bind:value={email}
          onkeydown={onKeydown}
          type="email"
          inputmode="email"
          autocomplete="email"
          autocapitalize="none"
          spellcheck="false"
          placeholder="you@example.com"
        />
      </label>

      <label class="field">
        <span>Password</span>
        <input
          bind:value={password}
          onkeydown={onKeydown}
          type="password"
          autocomplete={mode === 'create' ? 'new-password' : 'current-password'}
          minlength={mode === 'create' ? MIN_PASSWORD : undefined}
        />
        {#if mode === 'create'}
          <span class="hint">At least {MIN_PASSWORD} characters.</span>
        {/if}
      </label>

      {#if message}
        <p class="note" role="status">{message}</p>
      {/if}
    </div>

    <div class="card-foot">
      <button class="btn quiet" type="button" onclick={toggleMode}>
        {mode === 'sign-in' ? 'Create an account' : 'Sign in instead'}
      </button>
      <div class="right">
        <button class="btn primary" type="submit" disabled={session.busy}>{actionLabel}</button>
      </div>
    </div>
  </form>
</div>

<style>
  /* The brand and the form are one centred column: on a tall phone it sits in
     the middle of the screen, and on a short one the column scrolls instead of
     clipping its top. */
  .auth-page {
    display: flex;
    flex-direction: column;
    justify-content: center;
    flex: 1 1 auto;
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    gap: 1.75rem;
    padding: 2rem var(--gutter);
  }

  .brand {
    text-align: center;
  }

  /* Providers first, because that is how an account is made and reopened. The
     email form below is the fallback for a server that has no providers. */
  .providers {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* A provider is a plate with its vendor's mark on the left and the label on
     the line's own centre, so the two marks never look one-sided. The third
     column is empty and equal to the first, which is what centres the label. */
  .btn.provider {
    display: grid;
    grid-template-columns: 1.125rem minmax(0, 1fr) 1.125rem;
    align-items: center;
    gap: 0.625rem;
    min-height: 3rem;
    padding: 0 0.875rem;
    border: 1px solid var(--color-border-strong);
    background: var(--color-surface);
    font-size: 0.875rem;
    font-weight: 400;
  }

  .btn.provider .provider-label {
    grid-column: 2;
    min-width: 0;
    overflow: hidden;
    text-align: center;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .btn.provider:disabled {
    opacity: 0.45;
  }

  .provider-note {
    margin: 0.25rem 0 0;
    text-align: center;
    font-size: 0.75rem;
    color: var(--ink-meta);
  }

  .or {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: -0.5rem 0;
    font-size: 0.75rem;
    color: var(--ink-meta);
  }

  .or::before,
  .or::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--color-border);
  }

  .brand-mark {
    display: flex;
    justify-content: center;
    margin: 0 auto 0.75rem;
    color: var(--color-foreground);
  }

  .brand-name {
    margin: 0;
    font-size: 1.75rem;
    line-height: 1.1;
  }

  .brand-line {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    color: var(--color-muted);
  }

  /* The card is the form, so its fields are inset from the border the way the
     new-thread sheet insets its own, and the foot below carries the two
     controls. */
  .card.auth .fields {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.875rem;
  }

  /* The rule under a field belongs to the field, not to the next label. */
  .card.auth .hint {
    margin: 0;
    font-size: 0.75rem;
    color: var(--ink-meta);
  }

  .card.auth .note {
    padding: 0;
    color: var(--color-danger);
  }
</style>
