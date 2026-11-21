<script lang="ts">
  import { api, ApiError } from '#lib/api/client'
  import { session } from '#lib/stores/session.svelte'
  import Sheet from './Sheet.svelte'

  /**
   * The confirmation before an account is deleted. A password account confirms
   * with its password; one made through a provider types its own address. The
   * service drops the account's store with it, so nothing here can be undone.
   */
  interface Props {
    open: boolean
    onclose: () => void
    ondeleted: () => void
  }

  let { open, onclose, ondeleted }: Props = $props()

  let answer = $state('')
  let deleting = $state(false)
  let error = $state<string | null>(null)

  let hasPassword = $derived(session.user?.hasPassword !== false)
  let email = $derived(session.user?.email ?? '')
  let canDelete = $derived(
    !deleting &&
      (hasPassword
        ? answer.length > 0
        : answer.trim().toLowerCase() === email.toLowerCase() && email.length > 0)
  )

  function focusOnMount(node: HTMLInputElement): void {
    node.focus()
  }

  function close(): void {
    answer = ''
    error = null
    onclose()
  }

  async function remove(): Promise<void> {
    if (!canDelete) return
    deleting = true
    error = null
    try {
      await api.deleteAccount(hasPassword ? { password: answer } : { email: answer.trim() })
      answer = ''
      ondeleted()
    } catch (cause) {
      error = cause instanceof ApiError ? cause.message : 'Cannot reach CodeInOven right now.'
    } finally {
      deleting = false
    }
  }

  function onSubmit(event: SubmitEvent): void {
    event.preventDefault()
    void remove()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey)) return
    event.preventDefault()
    void remove()
  }
</script>

<Sheet {open} onclose={close} label="Delete account">
  <form class="sheet-form" onsubmit={onSubmit}>
    <div class="sheet-grab"></div>
    <div class="sheet-head">
      <h2>Delete account</h2>
    </div>

    <p class="sheet-error">
      Every project, thread and prompt in this account is deleted, and every device is signed out.
      This cannot be undone.
    </p>

    <label class="sheet-field">
      <span>{hasPassword ? 'Your password' : `Type ${email} to confirm`}</span>
      <input
        {@attach focusOnMount}
        bind:value={answer}
        onkeydown={onKeydown}
        type={hasPassword ? 'password' : 'email'}
        autocomplete={hasPassword ? 'current-password' : 'off'}
        autocapitalize="none"
        spellcheck="false"
      />
    </label>

    {#if error}
      <p class="sheet-error" role="status">{error}</p>
    {/if}

    <div class="sheet-foot">
      <button class="btn quiet" type="button" onclick={close}>Cancel</button>
      <button class="btn danger" type="submit" disabled={!canDelete}>
        {deleting ? 'Deleting' : 'Delete account'}
      </button>
    </div>
  </form>
</Sheet>
