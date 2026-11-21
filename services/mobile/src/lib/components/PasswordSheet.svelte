<script lang="ts">
  import { api, ApiError } from '#lib/api/client'
  import { session } from '#lib/stores/session.svelte'
  import Sheet from './Sheet.svelte'

  /**
   * Change the account's password, or set the first one for an account made
   * through Google or GitHub. Every other session is signed out by the service,
   * so the line under the button says how many.
   */
  interface Props {
    open: boolean
    onclose: () => void
    ondone: (revoked: number) => void
  }

  const MIN_PASSWORD = 12

  let { open, onclose, ondone }: Props = $props()

  let current = $state('')
  let next = $state('')
  let saving = $state(false)
  let error = $state<string | null>(null)

  let hasPassword = $derived(session.user?.hasPassword !== false)
  let title = $derived(hasPassword ? 'Change password' : 'Set a password')
  let canSave = $derived(
    !saving && next.length >= MIN_PASSWORD && (!hasPassword || current.length > 0)
  )

  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }

  function close(): void {
    current = ''
    next = ''
    error = null
    onclose()
  }

  async function save(): Promise<void> {
    if (!canSave) return
    saving = true
    error = null
    try {
      const result = await api.changePassword({ currentPassword: current, newPassword: next })
      if (session.user) session.user = { ...session.user, hasPassword: true }
      current = ''
      next = ''
      ondone(result.sessionsRevoked)
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
    } finally {
      saving = false
    }
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void save()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    void save()
  }
</script>

<Sheet {open} onclose={close} label={title}>
  <form class="sheet-form" onsubmit={onSubmit}>
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <h2>{title}</h2>
    </div>

    {#if hasPassword}
      <label class="sheet-field">
        <span>Current password</span>
        <input
          {@attach focusOnMount}
          bind:value={current}
          onkeydown={onKeydown}
          type="password"
          autocomplete="current-password"
        />
      </label>
    {/if}

    <label class="sheet-field">
      <span>New password, at least {MIN_PASSWORD} characters</span>
      {#if hasPassword}
        <input
          bind:value={next}
          onkeydown={onKeydown}
          type="password"
          autocomplete="new-password"
          minlength={MIN_PASSWORD}
        />
      {:else}
        <input
          {@attach focusOnMount}
          bind:value={next}
          onkeydown={onKeydown}
          type="password"
          autocomplete="new-password"
          minlength={MIN_PASSWORD}
        />
      {/if}
    </label>

    {#if error}
      <p class="sheet-error" role="status">{error}</p>
    {/if}

    <div class="sheet-foot">
      <button class="btn quiet" type="button" onclick={close}>Cancel</button>
      <button class="btn primary" type="submit" disabled={!canSave}>
        {saving ? 'Saving' : 'Save password'}
      </button>
    </div>
  </form>
</Sheet>
