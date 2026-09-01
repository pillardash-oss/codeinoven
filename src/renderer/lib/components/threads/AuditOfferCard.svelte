<script lang="ts">
  import { Loader2, ShieldCheck } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import type { ProviderCatalog, ThreadSettings, ThinkingLevel } from '$shared/types'

  interface Props {
    threadTitle: string
    reworkCycle?: number
    settings: ThreadSettings
    providers: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    busy?: boolean
    onCancel: () => void
    onAudit: (settings: ThreadSettings) => void
    onModelChange: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    threadTitle,
    reworkCycle,
    settings,
    providers,
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    busy = false,
    onCancel,
    onAudit,
    onModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()
  let selected = $derived.by(() => {
    const provider =
      providers.find(
        (candidate) =>
          candidate.id === settings.providerId && candidate.harnessId === settings.harnessId
      ) ?? providers.find((candidate) => candidate.id === settings.providerId)
    const model = provider?.models.find((candidate) => candidate.id === settings.modelId)
    return { provider, model }
  })

  function chooseModel(providerId: string, modelId: string, nextHarnessId?: string): void {
    const harnessId = nextHarnessId ?? settings.harnessId
    onModelChange({ ...settings, harnessId, providerId, modelId })
  }

  function chooseThinking(level: ThinkingLevel): void {
    onModelChange({ ...settings, thinkingLevel: level })
  }
</script>

<section class="rounded-xl border bg-surface p-4" aria-label="Audit implementation">
  <div class="flex items-start gap-3">
    <div class="rounded-lg bg-primary/10 p-2 text-primary"><ShieldCheck size={18} /></div>
    <div class="min-w-0 flex-1">
      <h3 class="text-sm font-semibold">
        {reworkCycle ? `Rework ${reworkCycle} complete — audit again` : 'Implementation finished'}
      </h3>
      <p class="mt-1 text-xs text-muted">
        {reworkCycle ? 'Verify the completed corrections for' : 'Audit'} “{threadTitle}” with
        <span class="font-medium text-foreground">
          {selected.model?.name ?? settings.modelId}
        </span>
        before marking it complete?
      </p>
      <p class="mt-1 text-[11px] text-dimmed">
        {selected.provider?.name ?? settings.providerId} / {selected.model?.name ??
          settings.modelId}
      </p>
    </div>
  </div>

  <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
    <button class="rounded-lg px-3 py-2 text-xs text-muted hover:bg-overlay" onclick={onCancel}>
      Cancel
    </button>
    <div class="ml-auto flex items-center justify-end gap-2">
      <ModelPicker
        {providers}
        {projectId}
        harnessId={settings.harnessId}
        providerId={settings.providerId}
        modelId={settings.modelId}
        {favoriteModels}
        {recentModels}
        {onRemoveRecent}
        side="top"
        label="Change"
        variant="action"
        onSelect={chooseModel}
        thinkingLevel={settings.thinkingLevel}
        onSelectThinking={chooseThinking}
        {onToggleFavorite}
        {onReorderFavorite}
      />
      <button
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary disabled:opacity-50"
        disabled={busy}
        onclick={() => onAudit(settings)}
      >
        {#if busy}<Loader2 size={13} class="animate-spin" />{/if}
        {reworkCycle ? 'Audit again' : 'Audit'}
      </button>
    </div>
  </div>
</section>
