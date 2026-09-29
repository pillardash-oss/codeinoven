<script lang="ts">
  interface Props {
    /** How far the download got, 0-100; clamped and rounded here so every
     *  surface shows the same number for the same download. */
    percent: number
    /** The file being downloaded, used to name the bar for assistive tech. */
    fileName: string
    class?: string
  }

  let { percent, fileName, class: className = '' }: Props = $props()

  const clamped = $derived(Math.min(100, Math.max(0, Math.round(percent))))
</script>

<!--
  One download's progress: the thin bar and its percentage. Shared by the
  downloads row and the close-confirmation prompt, so a download reads the same
  wherever it is shown.
-->
<div class="flex items-center gap-2 {className}">
  <div
    class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-overlay"
    role="progressbar"
    aria-label={`Download progress for ${fileName}`}
    aria-valuenow={clamped}
    aria-valuemin={0}
    aria-valuemax={100}
  >
    <div
      class="h-full rounded-full bg-primary transition-[width] duration-150"
      style={`width: ${clamped}%`}
    ></div>
  </div>
  <span class="w-9 shrink-0 text-right text-[0.625rem] tabular-nums text-dimmed">{clamped}%</span>
</div>
