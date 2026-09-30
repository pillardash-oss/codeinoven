<script lang="ts">
  import { Loader2 } from '@lucide/svelte'
  import type { BrowserExtensionProgress } from '$shared/ipc-contract'
  import type { BrowserExtensionInstall } from '$lib/stores/browser-extensions.svelte'

  /**
   * One install's progress, drawn by whichever surface started it.
   *
   * Installs queue and two run at once, so this is one card per install rather
   * than the single line the panel used to show: each has to name itself, or two
   * downloads would read as one that keeps changing its mind.
   */

  interface Props {
    install: BrowserExtensionInstall
  }

  let { install }: Props = $props()

  /** What each install step is called on screen. */
  const PHASE_LABELS: Record<BrowserExtensionProgress['phase'], string> = {
    queued: 'Waiting to install',
    resolving: 'Resolving the extension',
    downloading: 'Downloading',
    unpacking: 'Unpacking',
    pinning: 'Pinning the extension id',
    compat: 'Applying compatibility',
    registering: 'Registering',
    done: 'Finishing up',
    failed: 'Install failed'
  }

  /** What this install is called: the name the page gave it where there is one,
   *  because the raw label of a store install is an id. */
  const title = $derived(install.name ?? install.label)

  /** A queued install is not doing anything yet, so it wears no spinner. */
  const working = $derived(install.phase !== 'queued' && install.phase !== 'failed')

  const progressPercent = $derived(
    install.totalBytes > 0
      ? Math.min(100, Math.round((install.receivedBytes / install.totalBytes) * 100))
      : 0
  )
</script>

<div class="rounded-lg border bg-elevated/50 px-3 py-2.5">
  <div class="flex items-center gap-2">
    {#if working}
      <Loader2 size={13} class="shrink-0 animate-spin text-dimmed" />
    {/if}
    <p class="min-w-0 truncate text-xs font-medium text-foreground" {title}>{title}</p>
    {#if install.totalBytes > 0}
      <p class="ml-auto shrink-0 text-[0.625rem] tabular-nums text-dimmed">{progressPercent}%</p>
    {/if}
  </div>
  <p class="mt-0.5 text-[0.6875rem] leading-relaxed text-muted">
    {PHASE_LABELS[install.phase]}{install.detail ? ` · ${install.detail}` : ''}
  </p>
  {#if install.totalBytes > 0}
    <div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-overlay">
      <div
        class="h-full rounded-full bg-primary transition-[width] duration-150"
        style="width: {progressPercent}%"
      ></div>
    </div>
  {/if}
</div>
