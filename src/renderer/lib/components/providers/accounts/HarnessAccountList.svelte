<script lang="ts">
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { isCodeInOvenCustomProviderId } from '$shared/custom-provider-id'
  import type { HarnessAccount } from '$shared/types'
  import { harnessAccountUsageCache } from '$lib/stores/harness-account-usage.svelte'
  import HarnessAccountGlance from './HarnessAccountGlance.svelte'
  import type { AccountGroup } from './harness-account-presentation'

  interface Props {
    groups: readonly AccountGroup[]
    selectedId: string
    onselect: (account: HarnessAccount) => void
  }

  let { groups, selectedId, onselect }: Props = $props()

  function isExpired(account: HarnessAccount): boolean {
    return harnessAccountUsageCache.snapshotFor(account.id)?.reauthenticationRequired === true
  }
</script>

<div class="py-1.5">
  {#each groups as group (group.harnessId)}
    {@const hiddenCount = group.accounts.filter((account) => account.hidden === true).length}
    <div class="flex items-center justify-between gap-2 px-3.5 pb-1 pt-3">
      <span class="text-[0.6875rem] font-medium text-muted">{group.harnessName}</span>
      <span class="text-[0.6875rem] tabular-nums text-dimmed">
        {group.accounts.length}{hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
      </span>
    </div>
    {#each group.accounts as account (account.id)}
      <button
        type="button"
        class="block w-full border-l-2 px-3.5 py-2 text-left transition-colors {account.id ===
        selectedId
          ? 'border-accent bg-elevated'
          : 'border-transparent hover:bg-elevated/60'}"
        aria-current={account.id === selectedId ? 'true' : undefined}
        title={`Open ${account.label}`}
        onclick={() => onselect(account)}
      >
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="flex shrink-0 opacity-70" aria-hidden="true">
            <AgentIcon agentId={account.harnessId} label={group.harnessName} size={13} />
          </span>
          <span
            class="truncate text-xs font-semibold {account.hidden
              ? 'text-muted'
              : 'text-foreground'}">{account.label}</span
          >
          {#if account.isDefault}
            <span
              class="shrink-0 border border-accent/45 bg-accent/10 px-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-accent"
              title="Default account for this provider"
            >
              Default
            </span>
          {/if}
          {#if account.hidden}
            <span
              class="shrink-0 border bg-surface px-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted"
              title="Hidden from account pickers, still connected"
            >
              Hidden
            </span>
          {/if}
          {#if isExpired(account)}
            <span
              class="shrink-0 border border-danger/45 bg-danger/10 px-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-danger"
              title="The harness sign-in for this account expired"
            >
              Sign in
            </span>
          {/if}
          {#if isCodeInOvenCustomProviderId(account.providerId)}
            <span
              class="shrink-0 border bg-surface px-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-muted"
              title="Custom base URL provider"
            >
              Custom
            </span>
          {/if}
        </span>
        <span
          class="mt-0.5 block truncate text-[0.625rem] text-muted"
          title={`${group.harnessName} · ${account.providerName || account.providerId}`}
        >
          {account.providerName || account.providerId}
        </span>
        <span class="block">
          <HarnessAccountGlance {account} />
        </span>
      </button>
    {/each}
  {/each}
</div>
