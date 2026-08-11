<script lang="ts">
  import { AlertTriangle, Check, Loader2, RotateCw, Send } from '@lucide/svelte'
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
    onRetry: (requestId: string, selection: AgentModelSelection) => Promise<void>
    onIgnore: (requestId: string) => Promise<void>
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
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
  let networkRelated = $derived(request.kind === 'network')
  let working = $state(false)
  let actionError = $state('')

  async function retry(): Promise<void> {
    if (working) return
    actionError = ''
    working = true
    try {
      await onRetry(request.id, visionSelection)
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'The retry could not be sent.'
    } finally {
      working = false
    }
  }

  async function ignore(): Promise<void> {
    if (working) return
    actionError = ''
    working = true
    try {
      await onIgnore(request.id)
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'The instruction could not be sent.'
    } finally {
      working = false
    }
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
        {networkRelated ? 'Upload or network interrupted' : 'Vision model failed'}
      </p>
    </div>
    <button
      class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-30"
      disabled={working}
      onclick={() => void ignore()}
      aria-label="Ignore the vision model error and continue with whatever description was generated"
      title="Ignore and continue"
    >
      <Check size={15} />
    </button>
  </div>

  <div class="space-y-4 p-4">
    <div>
      <p class="text-sm font-semibold text-foreground">
        {networkRelated
          ? 'The image upload or vision response was interrupted'
          : 'The vision model could not describe this image'}
      </p>
      <p
        class="mt-1.5 break-words whitespace-pre-wrap rounded-lg bg-danger/5 px-3 py-2 font-mono text-[11px] leading-relaxed text-danger"
      >
        {request.error}
      </p>
      <p class="mt-2 text-xs leading-relaxed text-muted">
        {networkRelated
          ? 'This is usually caused by a slow or unstable connection. Retry allows more upload time; you can also choose another vision model or continue without the description.'
          : changed
            ? 'Retry with the selected vision model, ignore, or type a new message below to steer the agent another way.'
            : 'Pick a different vision model and retry, ignore, or type a new message below to steer the agent another way.'}
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
        disabled={working}
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
      disabled={working}
      onclick={() => void ignore()}
    >
      <Send size={13} />
      Ignore and send
    </button>
    <button
      class="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
      disabled={working}
      onclick={() => void retry()}
    >
      {#if working}
        <Loader2 size={13} class="animate-spin" />
      {:else}
        <RotateCw size={13} />
      {/if}
      {changed ? 'Retry with this model' : networkRelated ? 'Retry with more time' : 'Retry'}
    </button>
  </div>
</section>
