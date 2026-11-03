<script lang="ts">
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import type { DisplayTab } from '$lib/stores/display-panel.svelte'
  import { displayPanel } from '$lib/stores/display-panel.svelte'

  /**
   * The preview surface for one target.
   *
   * Two things matter here and nothing else: the frame fills the dock at its own
   * aspect ratio, and the stage tells main how large it is so the capture is
   * sized to what is painted. The demand is reported from a measurement, not a
   * guess, because the dock is user-resizable between 340 and 1600 px.
   *
   * `Fit` is the default because a phone is 19.5:9 and a dock is tall and narrow;
   * `1:1` is there for reading interface detail, and it scrolls.
   */

  interface Props {
    tab: DisplayTab
  }

  let { tab }: Props = $props()

  let stage = $state<HTMLDivElement | null>(null)
  let zoom = $state<'fit' | 'actual'>('fit')

  const frame = $derived(tab.frame)
  const status = $derived(tab.phase === 'failed' || tab.phase === 'retrying' ? tab.phase : null)

  $effect(() => {
    const element = stage
    // Reading the tab's own id makes this re-measure when the panel switches to
    // another target, so a tab that was never on screen still reports its size.
    const tabId = tab.id
    if (!element) return
    const report = (): void => {
      const rect = element.getBoundingClientRect()
      const longest = Math.max(rect.width, rect.height)
      if (longest <= 0) return
      displayPanel.reportStageSize(tabId, Math.round(longest * (window.devicePixelRatio || 1)))
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
    <p class="min-w-0 flex-1 truncate text-[0.625rem] text-dimmed" title={tab.label}>
      {tab.label}
      {#if frame}
        · {frame.width}×{frame.height}
      {/if}
    </p>
    <div class="flex shrink-0 items-center" role="group" aria-label="Preview scale">
      <button
        type="button"
        class="px-1.5 py-0.5 text-[0.625rem] transition-colors {zoom === 'fit'
          ? 'bg-elevated text-foreground'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
        aria-pressed={zoom === 'fit'}
        title="Fit the preview to the panel"
        onclick={() => (zoom = 'fit')}
      >
        Fit
      </button>
      <button
        type="button"
        class="px-1.5 py-0.5 text-[0.625rem] transition-colors {zoom === 'actual'
          ? 'bg-elevated text-foreground'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
        aria-pressed={zoom === 'actual'}
        title="Show the preview at its captured size"
        onclick={() => (zoom = 'actual')}
      >
        1:1
      </button>
    </div>
  </div>

  <div
    bind:this={stage}
    class="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-app"
    data-display-stage={tab.kind}
  >
    {#if frame}
      <img
        src={frame.dataUrl}
        alt={`Live preview of ${tab.label}`}
        class={zoom === 'fit' ? 'max-h-full max-w-full object-contain' : 'max-w-none shrink-0'}
        style={zoom === 'actual' ? `width:${frame.width}px;height:${frame.height}px` : undefined}
      />
    {:else}
      <p class="px-4 text-center text-[0.625rem] leading-relaxed text-dimmed" role="status">
        {tab.phase === 'failed' ? 'This target could not be read.' : 'Waiting for the first frame…'}
      </p>
    {/if}

    {#if status}
      <div
        class="absolute inset-x-0 bottom-0 flex items-start gap-1.5 bg-surface/95 px-2 py-1"
        role="status"
      >
        <CioAlertCircle size={12} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <p class="min-w-0 text-[0.625rem] leading-relaxed text-muted">
          {status === 'failed' ? 'Stopped' : 'Retrying'}{tab.stateDetail
            ? `: ${tab.stateDetail}`
            : '.'}
        </p>
      </div>
    {/if}
  </div>
</div>
