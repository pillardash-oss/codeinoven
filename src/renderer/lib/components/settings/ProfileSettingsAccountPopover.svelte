<script lang="ts">
  import { Check, LogIn, LogOut, RefreshCw } from '@lucide/svelte'
  import { Popover } from 'bits-ui'
  import type { AccountAuthProvider, AccountProfileState } from '$shared/types'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'

  interface Props {
    accountState: AccountProfileState
    signInOpen: boolean
    accountBusy: boolean
    signInError: string
    activeProvider: AccountAuthProvider | null
    onSignInOpenChange: (open: boolean) => void
    onBeginSignIn: (provider: AccountAuthProvider) => void
    onRefreshAccount: (showError?: boolean) => void
    onRequestSignOut: () => void
  }

  let {
    accountState,
    signInOpen,
    accountBusy,
    signInError,
    activeProvider,
    onSignInOpenChange,
    onBeginSignIn,
    onRefreshAccount,
    onRequestSignOut
  }: Props = $props()

  const accountProfile = $derived(accountState.profile)
  const accountInitials = $derived.by(() => {
    const source = accountProfile?.displayName || accountProfile?.email || ''
    return source
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('')
  })
</script>

<Popover.Root open={signInOpen} onOpenChange={onSignInOpenChange}>
  <Popover.Trigger
    class="flex h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold {accountProfile
      ? 'border hover:bg-elevated'
      : 'bg-primary text-on-primary hover:bg-primary-hover'}"
    title={accountProfile ? `Signed in as ${accountProfile.email}` : 'Sign in to CodeInOven'}
    aria-label={accountProfile
      ? `Signed in as ${accountProfile.displayName || accountProfile.email}`
      : 'Sign in to CodeInOven'}
  >
    {#if accountProfile}
      {#if accountProfile.image}
        <img class="h-5 w-5 rounded-full object-cover" src={accountProfile.image} alt="" />
      {:else}
        <span
          class="grid h-5 w-5 place-items-center rounded-full bg-primary text-[0.5625rem] font-bold text-on-primary"
          aria-hidden="true">{accountInitials}</span
        >
      {/if}
      <span class="max-w-32 truncate">{accountProfile.displayName}</span>
    {:else if accountState.status === 'pending'}
      <RefreshCw size={14} class="animate-spin" /> Sign-in pending
    {:else}
      <LogIn size={14} /> Sign in
    {/if}
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="bottom"
      align="end"
      sideOffset={8}
      collisionPadding={16}
      class="z-50 w-80 rounded-xl border bg-surface p-4 shadow-xl outline-none"
    >
      {#if accountProfile}
        <div class="flex items-center gap-3">
          <span
            class="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary text-xs font-bold text-on-primary"
          >
            {#if accountProfile.image}
              <img class="h-full w-full object-cover" src={accountProfile.image} alt="" />
            {:else}
              {accountInitials}
            {/if}
          </span>
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold">{accountProfile.displayName}</p>
            <p class="truncate text-xs text-muted">{accountProfile.email}</p>
          </div>
          <Check size={16} class="ml-auto shrink-0 text-primary" aria-hidden="true" />
        </div>
        <p class="mt-3 text-xs leading-relaxed text-muted">
          Your account is connected. Local analytics remain available on this device.
        </p>
        {#if signInError}
          <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {signInError}
          </p>
        {/if}
        <button
          type="button"
          class="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg border text-xs font-semibold text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
          title="Sign out of CodeInOven"
          disabled={accountBusy}
          onclick={onRequestSignOut}
        >
          <LogOut size={14} />
          Sign out
        </button>
      {:else if accountState.status === 'pending'}
        <p class="text-sm font-semibold">Finish signing in</p>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          Complete Google or Apple sign-in in your browser. CodeInOven will detect the secure
          callback automatically.
        </p>
        {#if signInError}
          <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {signInError}
          </p>
        {/if}
        <button
          type="button"
          class="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
          disabled={accountBusy}
          onclick={() => onRefreshAccount(true)}
        >
          <RefreshCw size={14} class={accountBusy ? 'animate-spin' : ''} />
          Check sign-in status
        </button>
      {:else}
        <p class="text-sm font-semibold">Sign in to CodeInOven</p>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          Continue with Google or Apple. If your account does not exist, it is created
          automatically.
        </p>
        {#if signInError}
          <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {signInError}
          </p>
        {/if}
        <div class="mt-4 space-y-2">
          <button
            type="button"
            class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-50"
            disabled={accountBusy}
            onclick={() => onBeginSignIn('google')}
          >
            <VendorIcon name="Google" size={16} />
            {activeProvider === 'google' ? 'Opening Google…' : 'Continue with Google'}
          </button>
          <button
            type="button"
            class="flex h-10 w-full items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold hover:bg-elevated disabled:opacity-50"
            disabled={accountBusy}
            onclick={() => onBeginSignIn('apple')}
          >
            <VendorIcon name="Apple" size={16} />
            {activeProvider === 'apple' ? 'Opening Apple…' : 'Continue with Apple'}
          </button>
        </div>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
