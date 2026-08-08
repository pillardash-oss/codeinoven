<script lang="ts">
  import { AlertTriangle, Check, RotateCw, Send } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import type {
    AgentModelSelection,
    ImageDescriptorErrorRequest,
    ProviderCatalog
  } from '$shared/types'

  interface Props {
    request: ImageDescriptorErrorRequest
    providers: ProviderCatalog[]
    projectId: string
    favoriteModels?: string[]
    recentModels?: string[]
    busy?: boolean
    onRetry: (requestId: string, selection: AgentModelSelection) => void
    onIgnore: (requestId: string) => void
    onToggleFavorite?: (providerId: string, modelId: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    request,
    providers,
    projectId,
    favoriteModels = [],
    recentModels = [],
    busy = false,
    onRetry,
    onIgnore,
    onToggleFavorite,
    onReorderFavorite
  }: Props = $props()

  /** User-chosen replacement model; null falls back to the failed selection. */
  let override = $state<AgentModelSelection | null>(null)
  let visionSelection = $derived(
    override ?? {
      harnessId: request.selection.harnessId,
      providerId: request.selection.providerId,
      modelId: request.selection.modelId
    }
  )
  let changed = $derived(
    override !== null &&
      (override.providerId !== request.selection.providerId ||
        override.modelId !== request.selection.modelId ||
        override.harnessId !== request.selection.harnessId)
  )
  let actionError = $state('')

  function retry(): void {
    actionError = ''
    onRetry(request.id, visionSelection)
  }

  function ignore(): void {
    actionError = ''
    onIgnore(request.id)
  }
</script>

<section
  class="overflow-hidden rounded-xl border border-danger/30 bg-surface shadow-sm"
  aria-label="Image descriptor error"
>
  <div class="flex items-center justify-between gap-3 border-b px-4 py-2.5">
    <div class="flex min-w-0 items-center gap-2">
      <AlertTriangle size={15} class="shrink-0 text-danger" />
      <p class="truncate text-xs font-semibold uppercase tracking-wide text-muted">
        Vision model failed
      </p>
    </div>
    <button
      class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-30"
      disabled={busy}
      onclick={ignore}
      aria-label="Ignore the vision model error and continue with whatever description was generated"
      title="Ignore and continue"
    >
      <Check size={15} />
    </button>
  </div>

  <div class="space-y-4 p-4">
    <div>
      <p class="text-sm font-semibold text-foreground">
        The vision model could not describe this image
      </p>
      <p
        class="mt-1.5 break-words whitespace-pre-wrap rounded-lg bg-danger/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-danger"
      >
        {request.error}
      </p>
      <p class="mt-2 text-xs leading-relaxed text-muted">
        {changed
          ? 'Retry with the selected vision model, or ignore and let the model work with whatever description was generated.'
          : 'Pick a different vision model and retry, or ignore and let the model work with whatever description was generated.'}
      </p>
    </div>

    <div>
      <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dimmed">
        Change vision model
      </p>
      <ModelPicker
        {providers}
        {projectId}
        harnessId={visionSelection.harnessId}
        providerId={visionSelection.providerId}
        modelId={visionSelection.modelId}
        {favoriteModels}
        {recentModels}
        visionOnly
        side="top"
        variant="field"
        disabled={busy}
        onSelect={(providerId, modelId, harnessId) => {
          override = { harnessId, providerId, modelId }
        }}
        {onToggleFavorite}
        {onReorderFavorite}
      />
    </div>

    {#if actionError}
      <p class="text-xs text-danger" role="alert">{actionError}</p>
    {/if}
  </div>

  <div class="flex items-center justify-between gap-2 border-t px-4 py-2.5">
    <button
      class="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
      disabled={busy}
      onclick={ignore}
    >
      <Send size={13} />
      Ignore and send
    </button>
    <button
      class="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
      disabled={busy}
      onclick={retry}
    >
      <RotateCw size={13} />
      {changed ? 'Retry with this model' : 'Retry'}
    </button>
  </div>
</section>
