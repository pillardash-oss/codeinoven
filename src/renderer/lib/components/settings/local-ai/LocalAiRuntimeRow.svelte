<script lang="ts">
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioCircle from '@pdslng/cio-icon/CioCircle.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import SettingsEntry from '../../shared/SettingsEntry.svelte'
  import SettingsStatusBadge from '../../shared/SettingsStatusBadge.svelte'
  import type { LocalAiRuntimeSummary } from '$shared/llama-cpp'

  interface Props {
    runtime: LocalAiRuntimeSummary
    /** Bundled vendor mark the row shows, matching the llama.cpp row beside it. */
    icon: string
  }

  let { runtime, icon }: Props = $props()

  const badge = $derived(
    runtime.available
      ? {
          Icon: CioCheckCircle,
          label: 'Available',
          classes: 'border-success/30 bg-success/10 text-success'
        }
      : {
          Icon: CioCircle,
          label: 'Not available',
          classes: 'border-border bg-raised text-muted'
        }
  )
</script>

<SettingsEntry>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
    <div class="flex min-w-0 flex-1 basis-48 items-center gap-3">
      <div
        class="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-elevated"
      >
        <VendorIcon name={icon} size={20} />
      </div>
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">{runtime.label}</p>
        <p class="truncate font-mono text-xs text-dimmed">{runtime.uses.join(' · ')}</p>
      </div>
    </div>
    <div class="ml-auto flex shrink-0 items-center">
      <SettingsStatusBadge label={badge.label} classes={badge.classes}>
        <badge.Icon size={12} class="shrink-0" />
      </SettingsStatusBadge>
    </div>
  </div>
  <p class="mt-3 truncate font-mono text-xs text-muted" title={runtime.detail}>{runtime.detail}</p>
</SettingsEntry>
