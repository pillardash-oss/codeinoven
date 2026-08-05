<script lang="ts">
  import { X, Search, Check } from '@lucide/svelte'
  import { getIconSvgDataUrl, generateInitialsIconSvg } from '$lib/project-svg-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { ScopeBucket } from '$shared/types'

  interface Props {
    open: boolean
    onClose: () => void
    threadId: string
    projectId: string
    currentBucketId: string
  }

  let { open, onClose, threadId, projectId, currentBucketId }: Props = $props()

  let query = $state('')
  let searchInput: HTMLInputElement | undefined = $state(undefined)
  let loadError = $state('')

  let buckets = $derived(
    (scopeState.boards.get(projectId)?.buckets ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .filter((bucket) => {
        const q = query.trim().toLowerCase()
        if (!q) return true
        return bucket.name.toLowerCase().includes(q)
      })
  )

  async function selectBucket(bucket: ScopeBucket): Promise<void> {
    try {
      const updated = await invoke('thread:update', projectId, threadId, {
        scopeBucketId: bucket.id
      })
      workspaceState.updateThread(updated)
      scopeState.updateThread(updated)
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Failed to change scope'
      return
    }
    onClose()
  }
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    if (!open) return
    if (e.key === 'Escape') onClose()
  }}
/>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <button class="absolute inset-0 bg-black/13" aria-label="Close" onclick={onClose}></button>
    <div class="relative w-full max-w-sm border bg-surface p-5 shadow-xl">
      <div class="mb-4 flex items-center justify-between">
        <h2 class="text-base font-semibold">Change Scope</h2>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close"
          title="Close"
          onclick={onClose}
        >
          <X size={16} />
        </button>
      </div>

      <div class="space-y-3">
        <div class="flex items-center gap-2 rounded-lg border bg-elevated px-3 py-2">
          <Search size={14} class="shrink-0 text-dimmed" />
          <input
            bind:this={searchInput}
            bind:value={query}
            type="search"
            class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-dimmed"
            placeholder="Search scopes..."
            aria-label="Search scopes"
          />
          {#if query}
            <button
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="Clear search"
              title="Clear search"
              onclick={() => {
                query = ''
                searchInput?.focus()
              }}
            >
              <X size={12} />
            </button>
          {/if}
        </div>

        {#if loadError}
          <p class="text-xs text-danger">{loadError}</p>
        {/if}
        <div class="max-h-72 space-y-0.5 overflow-y-auto">
          {#each buckets as bucket (bucket.id)}
            <button
              class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors {bucket.id ===
              currentBucketId
                ? 'bg-elevated text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'}"
              title={bucket.name}
              disabled={bucket.id === currentBucketId}
              onclick={() => void selectBucket(bucket)}
            >
              {#if bucket.iconType}
                <img
                  src={getIconSvgDataUrl(
                    bucket.iconType,
                    bucket.color ?? pickColorForSeed(bucket.id)
                  )}
                  alt=""
                  class="h-4 w-4 shrink-0 object-contain"
                  draggable="false"
                />
              {:else if bucket.color}
                <img
                  src={generateInitialsIconSvg(bucket.name, bucket.color)}
                  alt=""
                  class="h-4 w-4 shrink-0 object-contain"
                  draggable="false"
                />
              {:else}
                <span class="h-4 w-4 shrink-0 rounded-full bg-dimmed/20"></span>
              {/if}
              <span class="flex-1 truncate">{bucket.name}</span>
              {#if bucket.id === currentBucketId}
                <span class="flex shrink-0 items-center gap-1 text-[10px] text-dimmed">
                  <Check size={10} />
                  Current
                </span>
              {/if}
            </button>
          {:else}
            <p class="py-8 text-center text-xs text-dimmed">No scopes found</p>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}
