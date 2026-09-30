<script lang="ts">
  import { Loader2 } from '@lucide/svelte'
  import type { BrowserExtensionProgress } from '$shared/ipc-contract'

  /**
   * One install's progress, drawn by whichever surface started it.
   *
   * The install dialog owns the form, but an install also starts from the browser
   * chrome on a store page, where no dialog is open and the rail's extensions
   * panel is what shows it. One component means both places name the phases and
   * read the percentage the same way.
   */

  interface Props {
    progress: BrowserExtensionProgress
    /** Whether the install is still running, which is the only thing that makes
     *  the spinner meaningful: a finished install leaves its last line behind. */
    installing: boolean
  }

  let { progress, installing }: Props = $props()

  /** What each install step is called on screen. */
  const PHASE_LABELS: Record<BrowserExtensionProgress['phase'], string> = {
    resolving: 'Resolving the extension',
    downloading: 'Downloading',
    unpacking: 'Unpacking',
    pinning: 'Pinning the extension id',
    compat: 'Applying compatibility',
    registering: 'Registering',
    done: 'Finishing up',
    failed: 'Install failed'
  }

  const progressPercent = $derived(
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : 0
  )
</script>

<div class="rounded-lg border bg-elevated/50 px-3 py-2.5">
  <div class="flex items-center gap-2">
    {#if installing}
      <Loader2 size={13} class="shrink-0 animate-spin text-dimmed" />
    {/if}
    <p class="text-xs font-medium text-foreground">{PHASE_LABELS[progress.phase]}</p>
    {#if progress.totalBytes > 0}
      <p class="ml-auto text-[0.625rem] tabular-nums text-dimmed">{progressPercent}%</p>
    {/if}
  </div>
  {#if progress.detail}
    <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">{progress.detail}</p>
  {/if}
  {#if progress.totalBytes > 0}
    <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-overlay">
      <div
        class="h-full rounded-full bg-primary transition-[width] duration-150"
        style="width: {progressPercent}%"
      ></div>
    </div>
  {/if}
</div>
