<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Loader2 } from '@lucide/svelte'

  interface Props {
    src: string | null
    alt: string
    failed?: boolean
  }

  let { src, alt, failed = false }: Props = $props()

  /**
   * A transient `appfile://` request can fail once at startup, before the main
   * process finishes populating the preview file service. Instead of caching
   * that failure forever, retry with backoff; once the service is ready the
   * re-keyed `<img>` loads normally. `retryingFor` tracks which `src` the retry
   * counters belong to, so switching files naturally resets the sequence
   * without needing an `$effect`.
   */
  let retryingFor: string | null = null
  let retryAttempt = $state(0)
  let retriesDone = $state(0)
  let loadFailed = $state(false)
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const MAX_RETRIES = 6

  function resetFor(src: string | null): void {
    if (retryingFor === src) return
    retryingFor = src
    retryAttempt = 0
    retriesDone = 0
    loadFailed = false
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function handleLoad(): void {
    resetFor(src)
  }

  function handleError(): void {
    resetFor(src)
    if (retriesDone >= MAX_RETRIES) {
      loadFailed = true
      return
    }
    loadFailed = false
    retriesDone += 1
    const delay = 600 * 2 ** (retriesDone - 1)
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (retryingFor === src) retryAttempt += 1
    }, delay)
  }

  onDestroy(() => {
    if (retryTimer) clearTimeout(retryTimer)
  })
</script>

<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
  {#if src}
    {#key `${src}|${retryAttempt}`}
      <img
        {src}
        {alt}
        class="max-h-full max-w-full object-contain"
        onload={handleLoad}
        onerror={handleError}
      />
    {/key}
    {#if loadFailed}
      <p class="text-xs font-medium text-danger">This image could not be loaded</p>
    {/if}
  {:else if failed}
    <p class="text-xs font-medium text-danger">This image could not be loaded</p>
  {:else}
    <div class="flex items-center justify-center gap-2 text-[0.6875rem] text-dimmed">
      <Loader2 size={13} class="animate-spin" />
      Loading image preview
    </div>
  {/if}
</div>
