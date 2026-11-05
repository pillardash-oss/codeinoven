<script lang="ts">
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { onMount } from 'svelte'
  import type { AcpAgentAuthStatus, AcpAuthMethod } from '$shared/acp'
  import { invoke } from '$lib/ipc.svelte'

  /**
   * Sign-in for an ACP harness, driven by the agent itself.
   *
   * An ACP agent owns its providers and models, so there is no provider list to
   * add to and no login command to hand to a terminal: the agent declares the
   * methods it accepts during `initialize` and runs the one the user picks over
   * the protocol. This panel shows the state the agent reports and offers those
   * methods, which is the whole reason an ACP harness no longer reads "sign-in
   * not supported by this harness".
   */
  interface Props {
    harnessId: string
    harnessName: string
    /** Chat project path, so the probe runs where the agent expects to work. */
    projectPath?: string
  }

  let { harnessId, harnessName, projectPath }: Props = $props()

  let status = $state<AcpAgentAuthStatus | null>(null)
  let checking = $state(false)
  let busyMethod = $state('')
  let error = $state('')
  let notice = $state('')

  const authenticated = $derived(status?.state === 'authenticated')
  const methods = $derived<AcpAuthMethod[]>(status?.methods ?? [])

  const stateLabel = $derived.by(() => {
    if (checking && status === null) return `Asking ${harnessName} for its sign-in state…`
    if (status === null) return 'Not checked'
    switch (status.state) {
      case 'authenticated':
        return `Signed in · ${harnessName} is ready`
      case 'unauthenticated':
        return 'Sign-in required'
      case 'unknown':
        return 'Status unknown'
    }
  })

  async function check(): Promise<void> {
    checking = true
    error = ''
    try {
      status = await invoke('acpAgents:authStatus', harnessId, projectPath)
    } catch (probeError) {
      error =
        probeError instanceof Error
          ? probeError.message
          : `${harnessName} did not answer the sign-in check.`
    } finally {
      checking = false
    }
  }

  async function authenticate(method: AcpAuthMethod): Promise<void> {
    if (busyMethod) return
    busyMethod = method.id
    error = ''
    notice = ''
    try {
      status = await invoke('acpAgents:authenticate', harnessId, method.id, projectPath)
      notice =
        status.state === 'authenticated'
          ? `${method.name} finished. ${harnessName} is signed in.`
          : `${method.name} finished, but ${harnessName} still refuses a session.`
    } catch (authError) {
      error =
        authError instanceof Error ? authError.message : `${method.name} could not be completed.`
    } finally {
      busyMethod = ''
    }
  }

  onMount(() => {
    void check()
  })
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3 border bg-surface px-3 py-2.5">
    <div class="flex min-w-0 items-center gap-2">
      {#if authenticated}
        <CioCheckCircle size={15} class="shrink-0 text-success" />
      {:else}
        <CioKey size={15} class="shrink-0 text-dimmed" />
      {/if}
      <p class="truncate text-xs font-medium">{stateLabel}</p>
    </div>
    <button
      class="flex h-7 items-center gap-1 border bg-elevated px-2 text-[0.6875rem] font-medium hover:bg-overlay disabled:opacity-50"
      type="button"
      title="Re-check {harnessName} sign-in status"
      disabled={checking}
      onclick={() => void check()}
    >
      <CioRefresh size={11} class={checking ? 'animate-spin' : ''} />
      Check
    </button>
  </div>

  {#if error}
    <p class="border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {error}
    </p>
  {/if}

  {#if notice}
    <p class="border border-success/30 bg-success/10 px-3 py-2 text-xs text-success" role="status">
      {notice}
    </p>
  {/if}

  {#if status?.detail && !authenticated && !error}
    <p class="border bg-surface px-3 py-2 text-[0.6875rem] leading-relaxed text-muted">
      <span class="font-medium text-foreground">{harnessName} said:</span>
      {status.detail}
    </p>
  {/if}

  {#if methods.length > 0}
    <div class="overflow-hidden border bg-surface">
      <div
        class="border-b bg-elevated px-3 py-2 text-[0.625rem] font-medium uppercase tracking-wide text-dimmed"
      >
        Sign-in methods {harnessName} accepts
      </div>
      {#each methods as method (method.id)}
        <div class="flex items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium text-foreground">{method.name}</p>
            {#if method.description}
              <p class="mt-0.5 text-[0.625rem] leading-relaxed text-dimmed">
                {method.description}
              </p>
            {/if}
          </div>
          <button
            class="flex h-7 shrink-0 items-center gap-1.5 bg-primary px-2.5 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            type="button"
            title="Sign in to {harnessName} with {method.name}"
            disabled={busyMethod !== ''}
            onclick={() => void authenticate(method)}
          >
            {#if busyMethod === method.id}<CioSpinner size={11} class="animate-spin" />{/if}
            <CioKey size={11} /> Sign in
          </button>
        </div>
      {/each}
    </div>
  {:else if !checking}
    <div class="border border-dashed px-3 py-4 text-center">
      <p class="text-xs text-muted">
        {harnessName} declares no sign-in methods. It may need no sign-in at all, or its credentials live
        in its own settings.
      </p>
    </div>
  {/if}
</div>
