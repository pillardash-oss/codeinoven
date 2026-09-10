<script lang="ts">
  import { Check, Loader2, UserRound } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { HarnessAccount } from '$shared/types'

  interface Props {
    harnessId: string
    accountId?: string
    onSelect: (account: HarnessAccount) => void
  }

  let { harnessId, accountId, onSelect }: Props = $props()
  let open = $state(false)
  let loading = $state(false)
  let accounts = $state.raw<HarnessAccount[]>([])

  const effectiveAccountId = $derived(accountId ?? `${harnessId}.default`)
  const selected = $derived(accounts.find((account) => account.id === effectiveAccountId))
  const label = $derived(
    selected?.label ?? (effectiveAccountId === `${harnessId}.default` ? 'Default' : 'Account')
  )

  async function loadAccounts(): Promise<void> {
    loading = true
    try {
      accounts = await invoke('providerAccounts:list', harnessId)
    } finally {
      loading = false
    }
  }

  async function show(): Promise<void> {
    open = !open
    if (!open) return
    await loadAccounts()
  }

  function choose(account: HarnessAccount): void {
    open = false
    onSelect(account)
  }

  onMount(() => {
    void loadAccounts()
  })
</script>

<div class="relative">
  <button
    type="button"
    class="flex h-7 max-w-32 items-center gap-1.5 rounded-lg px-2 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
    title={`Account: ${label}`}
    aria-label={`Account: ${label}`}
    onclick={() => void show()}
  >
    <UserRound size={12} />
    <span class="truncate">{label}</span>
  </button>

  {#if open}
    <button
      type="button"
      class="fixed inset-0 z-30 cursor-default"
      aria-label="Close account menu"
      title="Close account menu"
      onclick={() => (open = false)}
    ></button>
    <div class="absolute bottom-9 left-0 z-40 min-w-44 rounded-xl border bg-surface p-1 shadow-lg">
      {#if loading}
        <div class="flex h-12 items-center justify-center text-dimmed">
          <Loader2 size={14} class="animate-spin" />
        </div>
      {:else}
        {#each accounts as account (account.id)}
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-elevated {account.id ===
            effectiveAccountId
              ? 'font-medium text-foreground'
              : 'text-muted'}"
            title={`Use ${account.label} for the next message`}
            onclick={() => choose(account)}
          >
            <span class="flex size-4 items-center justify-center">
              {#if account.id === effectiveAccountId}<Check size={12} />{/if}
            </span>
            <span class="min-w-0 flex-1 truncate">{account.label}</span>
            {#if account.providerId}
              <span class="max-w-24 truncate font-mono text-[0.625rem] text-dimmed">
                {account.providerId}
              </span>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>
