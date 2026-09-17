<script lang="ts">
  import { Pencil, Server } from '@lucide/svelte'
  import type { BaseUrlProvider, ProviderConnectionInfo } from '$shared/types'

  interface Props {
    harness: ProviderConnectionInfo
    customProviders: BaseUrlProvider[]
    customCount: number
    onEditCustom: (provider: BaseUrlProvider) => void
  }

  let { harness, customProviders, customCount, onEditCustom }: Props = $props()
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between rounded-xl border bg-surface px-3 py-2.5">
    <p class="text-xs">
      <strong class="font-medium">Custom providers for {harness.name}</strong>
      <span class="ml-1.5 text-dimmed">
        {customCount} provider{customCount === 1 ? '' : 's'}
      </span>
    </p>
  </div>

  {#if customProviders.length > 0}
    <div class="space-y-1.5">
      <p class="text-[0.6875rem] font-medium text-dimmed">Custom providers</p>
      {#each customProviders as provider (provider.id)}
        <div class="flex items-center justify-between gap-2 rounded-lg border bg-surface px-3 py-2">
          <div class="flex min-w-0 items-center gap-2">
            <Server size={13} class="shrink-0 text-dimmed" />
            <span class="truncate text-xs">{provider.name}</span>
            <span
              class="truncate rounded-full bg-elevated px-1.5 py-0.5 font-mono text-[0.625rem] text-dimmed"
              title={provider.baseURL}
            >
              {provider.baseURL}
            </span>
            {#if !provider.enabled}
              <span
                class="shrink-0 rounded-full bg-raised px-1.5 py-0.5 text-[0.625rem] font-medium text-dimmed"
              >
                Disabled
              </span>
            {/if}
          </div>
          <button
            class="flex h-7 shrink-0 items-center gap-1 rounded-lg border bg-elevated px-2 text-[0.6875rem] font-medium hover:bg-overlay"
            title="Edit {provider.name}"
            type="button"
            onclick={() => onEditCustom(provider)}
          >
            <Pencil size={11} /> Edit
          </button>
        </div>
      {/each}
    </div>
  {:else}
    <div class="rounded-xl border border-dashed p-4 text-center">
      <p class="text-xs text-muted">
        No custom providers for {harness.name} yet. Click
        <strong class="font-medium text-foreground">Open custom provider form</strong> below to add one.
      </p>
    </div>
  {/if}
</div>
