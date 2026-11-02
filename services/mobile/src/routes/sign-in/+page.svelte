<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import BrandMark from '#lib/components/BrandMark.svelte'
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
    if (session.signedIn) void goto('/')
  })
</script>

<div class="auth-page">
  <div class="brand">
    <div class="brand-mark"><BrandMark size={56} /></div>
    <p class="wordmark brand-name">CodeInOven</p>
    <p class="brand-line">The desktop's work, in your pocket.</p>
  </div>

  <form class="card auth" onsubmit={onSubmit} aria-busy={session.busy} novalidate>
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
    </label>

    {#if mode === 'create'}
      <p class="hint">At least {MIN_PASSWORD} characters.</p>
    {/if}

    {#if message}
      <p class="note" role="status">{message}</p>
    {/if}

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

  /* The card is the form, so the first field needs the head's breathing room. */
  .card.auth {
    padding-top: 0.75rem;
  }

  .hint {
    margin: -0.25rem 0.75rem 0.75rem;
    font-size: 0.75rem;
    color: var(--ink-meta);
  }
</style>
