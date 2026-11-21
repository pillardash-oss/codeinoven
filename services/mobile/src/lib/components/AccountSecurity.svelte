<script lang="ts">
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import CioInbox from '@pdslng/cio-icon/CioInbox.svelte'
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioUserMinus from '@pdslng/cio-icon/CioUserMinus.svelte'
  import { api, ApiError } from '#lib/api/client'
  import { formatAge } from '#lib/api/status'
  import type { Session } from '#lib/api/types'
  import { session } from '#lib/stores/session.svelte'
  import DeleteAccountSheet from './DeleteAccountSheet.svelte'
  import PasswordSheet from './PasswordSheet.svelte'

  /**
   * The account's security rows on Settings: the verification mail for an
   * address that is not confirmed, the sessions signed in, the password, and
   * the way to delete the account.
   */
  let sessions = $state<Session[]>([])
  let sessionsLoading = $state(true)
  let sessionsError = $state<string | null>(null)
  let revokingId = $state<string | null>(null)
  let confirmSessionId = $state<string | null>(null)

  let resendState = $state<'idle' | 'sending' | 'sent'>('idle')
  let note = $state<string | null>(null)
  let passwordOpen = $state(false)
  let deleteOpen = $state(false)

  let unverified = $derived(session.user !== null && session.user.emailVerifiedAt === null)
  let passwordTitle = $derived(
    session.user?.hasPassword === false ? 'Set a password' : 'Change password'
  )

  function failure(cause: unknown): string {
    return cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
  }

  export async function loadSessions(): Promise<void> {
    sessionsLoading = true
    sessionsError = null
    try {
      sessions = await api.sessions()
    } catch (cause) {
      sessionsError = failure(cause)
    } finally {
      sessionsLoading = false
    }
  }

  async function revokeSession(entry: Session): Promise<void> {
    if (revokingId !== null) return
    revokingId = entry.id
    sessionsError = null
    try {
      await api.revokeSession(entry.id)
      confirmSessionId = null
      if (entry.current) {
        await session.signOut()
        await goto('/sign-in')
        return
      }
      sessions = sessions.filter((item) => item.id !== entry.id)
    } catch (cause) {
      sessionsError = failure(cause)
    } finally {
      revokingId = null
    }
  }

  async function resend(): Promise<void> {
    const email = session.user?.email
    if (!email || resendState === 'sending') return
    resendState = 'sending'
    note = null
    try {
      await api.resendVerification({ email })
      resendState = 'sent'
    } catch (cause) {
      resendState = 'idle'
      note = failure(cause)
    }
  }

  function passwordSaved(revoked: number): void {
    passwordOpen = false
    note =
      revoked === 0
        ? 'Password saved.'
        : `Password saved. ${revoked} other ${revoked === 1 ? 'session was' : 'sessions were'} signed out.`
    void loadSessions()
  }

  async function accountDeleted(): Promise<void> {
    deleteOpen = false
    await session.signOut()
    await goto('/sign-in')
  }

  function sessionLabel(entry: Session): string {
    return entry.userAgent?.trim() || 'Unknown client'
  }

  onMount(() => {
    void loadSessions()
  })
</script>

<p class="set-head">Security</p>

{#if unverified}
  <div class="set-row">
    <span class="plate"><CioInbox size={16} /></span>
    <span class="body-cell">
      <span class="row-title">Email not verified</span>
      <span class="row-line">
        {resendState === 'sent' ? 'A new link is on its way' : 'Open the link we mailed you'}
      </span>
    </span>
    <button class="btn quiet" type="button" onclick={resend} disabled={resendState !== 'idle'}>
      {resendState === 'sending' ? 'Sending' : 'Resend'}
    </button>
  </div>
{/if}

<div class="set-row">
  <span class="plate"><CioKey size={16} /></span>
  <span class="body-cell">
    <span class="row-title">{passwordTitle}</span>
    <span class="row-line">Signs every other session out</span>
  </span>
  <button class="btn quiet" type="button" onclick={() => (passwordOpen = true)}>
    {session.user?.hasPassword === false ? 'Set' : 'Change'}
  </button>
</div>

{#if note}
  <p class="set-note" role="status">{note}</p>
{/if}

<p class="set-head">Sessions</p>

{#if sessionsLoading}
  <div class="set-row">
    <span class="body-cell"><span class="row-line">Reading your sessions</span></span>
  </div>
{:else}
  {#each sessions as entry (entry.id)}
    <div class="set-row">
      <span class="body-cell">
        <span class="row-title">{sessionLabel(entry)}</span>
        <span class="row-line">
          {entry.current ? 'This session · ' : ''}used {formatAge(entry.lastUsedAt)}
        </span>
      </span>
      <button class="btn quiet" type="button" onclick={() => (confirmSessionId = entry.id)}>
        Revoke
      </button>
    </div>
    {#if confirmSessionId === entry.id}
      <div class="confirm">
        <button class="btn quiet" type="button" onclick={() => (confirmSessionId = null)}>
          Cancel
        </button>
        <span>{entry.current ? 'Sign this device out?' : 'Revoke this session?'}</span>
        <button
          class="btn primary"
          type="button"
          onclick={() => revokeSession(entry)}
          disabled={revokingId !== null}
        >
          {revokingId === entry.id ? 'Revoking' : 'Revoke'}
        </button>
      </div>
    {/if}
  {/each}
{/if}

{#if sessionsError}
  <p class="set-note" role="status">{sessionsError}</p>
  <div class="set-row actions-row">
    <span></span>
    <button class="btn" type="button" onclick={loadSessions}>Retry</button>
  </div>
{/if}

<p class="set-head">Danger</p>

<div class="set-row">
  <span class="plate"><CioUserMinus size={16} /></span>
  <span class="body-cell">
    <span class="row-title">Delete account</span>
    <span class="row-line">Removes every project and thread on the service</span>
  </span>
  <button class="btn quiet" type="button" onclick={() => (deleteOpen = true)}>Delete</button>
</div>

<PasswordSheet open={passwordOpen} onclose={() => (passwordOpen = false)} ondone={passwordSaved} />
<DeleteAccountSheet
  open={deleteOpen}
  onclose={() => (deleteOpen = false)}
  ondeleted={accountDeleted}
/>
