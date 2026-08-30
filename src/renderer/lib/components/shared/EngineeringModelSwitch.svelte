<script lang="ts">
  import ModelPicker from './ModelPicker.svelte'
  import type { ProviderCatalog, ThreadSettings, ThinkingLevel } from '$shared/types'
  import { normalizeFastInference, supportsFastInference } from '$shared/fast-inference'

  interface Props {
    /** Current thread settings; the switch renders nothing without them. */
    settings?: ThreadSettings
    providers?: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    side?: 'top' | 'bottom'
    label?: string
    onModelChange?: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    settings,
    providers = [],
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    side = 'top',
    label = 'Change',
    onModelChange,
    onToggleFavorite,
    onReorderFavorite
  }: Props = $props()

  /** Commit a new thread model, mirroring the pattern used by the provider
   *  status card and the Audit/Spec ready cards. Fast inference only survives
   *  the switch when the newly selected model actually exposes a fast tier. */
  function chooseModel(providerId: string, modelId: string, nextHarnessId?: string): void {
    if (!settings || !onModelChange) return
    const harnessId = nextHarnessId ?? settings.harnessId
    const provider = providers.find(
      (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
    )
    const model = provider?.models.find((candidate) => candidate.id === modelId)
    onModelChange(
      normalizeFastInference(
        { ...settings, harnessId, providerId, modelId },
        harnessId,
        providerId,
        modelId,
        supportsFastInference(harnessId, providerId, model?.fastSupported)
      )
    )
  }

  function chooseThinking(level: ThinkingLevel): void {
    if (!settings || !onModelChange) return
    onModelChange({ ...settings, thinkingLevel: level })
  }
</script>

{#if settings && providers.length > 0 && onModelChange}
  <ModelPicker
    {providers}
    {projectId}
    harnessId={settings.harnessId}
    providerId={settings.providerId}
    modelId={settings.modelId}
    {favoriteModels}
    {recentModels}
    {side}
    {label}
    variant="action"
    onSelect={chooseModel}
    thinkingLevel={settings.thinkingLevel}
    onSelectThinking={chooseThinking}
    {onToggleFavorite}
    {onReorderFavorite}
  />
{/if}
