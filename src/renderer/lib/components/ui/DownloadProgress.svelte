<script lang="ts">
  import { LoaderCircle, Pause, Play, X } from '@lucide/svelte'

  interface Props {
    /** 0-100 when determinate, undefined for indeterminate installing */
    percent?: number
    /** Primary label, e.g. "Downloading… 42%" or "Verifying…" */
    label: string
    /** Secondary detail, e.g. "123.4 MB / 350 MB" or "checksum" */
    detail?: string
    /** Visual variant */
    tone?: 'default' | 'verifying'
    /** When true, shows an indeterminate shimmer */
    indeterminate?: boolean
    /** Called when user clicks Cancel (×). Omit to hide cancel. */
    onCancel?: () => void
    cancelLabel?: string
    /** Pause/resume — only for resumable transports (e.g. browser downloads) */
    onPause?: () => void
    onResume?: () => void
    paused?: boolean
    /** a11y label for the progressbar */
    ariaLabel?: string
    /** Hint below bar */
    hint?: string
  }

  let {
    percent,
    label,
    detail,
    tone = 'default',
    indeterminate = false,
    onCancel,
    cancelLabel = 'Cancel',
    onPause,
    onResume,
    paused = false,
    ariaLabel,
    hint
  }: Props = $props()

  const pct = $derived(percent !== undefined ? Math.min(100, Math.max(0, Math.round(percent))) : undefined)
  const barClass = $derived(tone === 'verifying' ? 'bg-amber-500 animate-pulse' : 'bg-primary')
</script>

<div class="rounded-lg border bg-surface px-3 py-2.5">
  <div class="flex items-center justify-between gap-2 text-[0.6875rem]">
    <span class="inline-flex items-center gap-1.5 font-medium {tone === 'verifying' ? 'text-amber-600' : 'text-foreground'}">
      {#if !indeterminate}
        <LoaderCircle size={11} class="animate-spin shrink-0" aria-hidden="true" />
      {:else}
        <LoaderCircle size={11} class="animate-spin shrink-0 opacity-60" aria-hidden="true" />
      {/if}
      <span>{label}</span>
      {#if pct !== undefined && !indeterminate}
        <span class="tabular-nums">· {pct}%</span>
      {/if}
    </span>
    <span class="flex items-center gap-1.5 shrink-0">
      {#if detail}
        <span class="tabular-nums text-muted">{detail}</span>
      {/if}
      {#if onPause && onResume}
        {#if paused}
          <button type="button" class="flex h-6 w-6 items-center justify-center rounded-md border bg-elevated hover:bg-overlay" title="Resume" aria-label="Resume download" onclick={onResume}><Play size={11} aria-hidden="true" /></button>
        {:else}
          <button type="button" class="flex h-6 w-6 items-center justify-center rounded-md border bg-elevated hover:bg-overlay" title="Pause" aria-label="Pause download" onclick={onPause}><Pause size={11} aria-hidden="true" /></button>
        {/if}
      {/if}
      {#if onCancel}
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-md border bg-elevated hover:bg-overlay" title={cancelLabel} aria-label={cancelLabel} onclick={onCancel}><X size={11} aria-hidden="true" /></button>
      {/if}
    </span>
  </div>
  <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/15" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={ariaLabel ?? label}>
    {#if indeterminate}
      <div class="indeterminate-progress h-full w-1/3 rounded-full bg-primary"></div>
    {:else}
      <div class="h-full rounded-full transition-all duration-200 {barClass}" style={`width: ${pct ?? 0}%`}></div>
    {/if}
  </div>
  {#if hint}
    <p class="mt-1.5 text-[0.625rem] leading-none text-dimmed">{hint}</p>
  {/if}
</div>
