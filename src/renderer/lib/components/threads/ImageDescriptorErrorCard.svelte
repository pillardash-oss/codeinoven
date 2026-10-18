<script lang="ts">
  import CioAttention from '@codeinoven/icons/CioAttention.svelte'
  import CioCheck from '@codeinoven/icons/CioCheck.svelte'
  import CioEye from '@codeinoven/icons/CioEye.svelte'
  import CioImage from '@codeinoven/icons/CioImage.svelte'
  import CioImagePlus from '@codeinoven/icons/CioImagePlus.svelte'
  import CioRefresh from '@codeinoven/icons/CioRefresh.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import Switch from '../ui/Switch.svelte'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import type {
    AgentModelSelection,
    ImageDescriptorErrorRequest,
    ProviderCatalog,
    ThinkingLevel
  } from '$shared/types'

  interface Props {
    request: ImageDescriptorErrorRequest
    providers: ProviderCatalog[]
    projectId: string
    favoriteModels?: string[]
    recentModels?: string[]
    onRetry: (requestId: string, selection: AgentModelSelection, remember: boolean) => Promise<void>
    onIgnore: (requestId: string) => Promise<void>
    /** Opens a file picker for a replacement image and retries with it. */
    onPickImage: (requestId: string) => Promise<void>
    /** Records the model executing the turn as vision-capable, then continues. */
    onFalsePositive: (requestId: string) => Promise<void>
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    /** Another card sits directly above this one, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** The surface below carries the join, so this card drops its bottom rule. */
    joinsBelow?: boolean
    /** Thread the card belongs to, so its fold state is remembered per thread. */
    threadId?: string
  }

  let {
    request,
    providers,
    projectId,
    favoriteModels = [],
    recentModels = [],
    onRetry,
    onIgnore,
    onPickImage,
    onFalsePositive,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite,
    stackedAbove = false,
    joinsBelow = false,
    threadId
  }: Props = $props()

  /** The fold control writes a per-thread preference, so the card stays folded or
   *  unfolded when the thread is reopened. */
  let localFolded = $state(false)
  const foldState = {
    get folded(): boolean {
      return threadId === undefined
        ? localFolded
        : threadCardFold.isFolded(threadId, 'image-descriptor')
    },
    set folded(value: boolean) {
      if (threadId === undefined) localFolded = value
      else threadCardFold.setFolded(threadId, 'image-descriptor', value)
    }
  }
  /** User-chosen replacement model; null falls back to the failed selection. */
  let override = $state<AgentModelSelection | null>(null)
  let remember = $state(false)
  let visionSelection = $derived(override ?? request.selection ?? null)
  let changed = $derived(
    override !== null &&
      (override.providerId !== request.selection?.providerId ||
        override.modelId !== request.selection?.modelId ||
        override.harnessId !== request.selection?.harnessId)
  )
  let networkRelated = $derived(request.kind === 'network')
  /** Display name of the model that was executing the turn, when known. */
  let requestingModelLabel = $derived.by(() => {
    const model = request.requestingModel
    if (!model) return ''
    const provider =
      providers.find(
        (candidate) => candidate.harnessId === model.harnessId && candidate.id === model.providerId
      ) ?? providers.find((candidate) => candidate.id === model.providerId)
    return (
      provider?.models.find((candidate) => candidate.id === model.modelId)?.name ?? model.modelId
    )
  })
  let falsePositiveTitle = $derived(
    requestingModelLabel
      ? `Report that ${requestingModelLabel} has vision`
      : 'Report that this model has vision'
  )
  let needsSelection = $derived(request.selection === undefined)
  let working = $state(false)
  let actionError = $state('')

  /** The card's real heading; the image mark only shows when an image is named. */
  let cardTitle = $derived(
    needsSelection
      ? `${request.assignmentTaskTitle ?? 'Task'} needs an image model`
      : networkRelated
        ? 'Upload or network interrupted'
        : 'Vision model failed'
  )

  let retryTitle = $derived(
    needsSelection
      ? 'Choose a vision-capable model and continue the blocked worker'
      : changed
        ? 'Retry describing the image with the selected vision model'
        : networkRelated
          ? 'Retry describing the image with a longer upload window'
          : 'Retry describing the image'
  )

  function chooseThinking(level: ThinkingLevel): void {
    const base = override ?? request.selection
    if (!base) return
    override = { ...base, thinkingLevel: level }
  }

  function chooseRuntime(runtime: import('$shared/types').ModelRuntimeSettings): void {
    const base = override ?? request.selection
    if (!base) return
    override = { ...base, ...runtime }
  }

  async function retry(): Promise<void> {
    const selection = visionSelection
    if (working || !selection) return
    actionError = ''
    working = true
    try {
      await onRetry(request.id, selection, remember)
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

  async function pickNewImage(): Promise<void> {
    if (working) return
    actionError = ''
    working = true
    try {
      await onPickImage(request.id)
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'The new image could not be attached.'
    } finally {
      working = false
    }
  }

  async function reportFalsePositive(): Promise<void> {
    if (working) return
    actionError = ''
    working = true
    try {
      await onFalsePositive(request.id)
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'The report could not be saved.'
    } finally {
      working = false
    }
  }
</script>

<div out:slide={dismissSlide()}>
  <CardFrame placement="replace" label="Image descriptor error" {stackedAbove} {joinsBelow}>
    <CardHead
      icon={request.imageId ? CioImage : CioAttention}
      title={cardTitle}
      chip={{ text: 'Stopped', tone: 'urgent' }}
      bind:folded={foldState.folded}
      foldLabel="vision model error"
    />

    {#if !foldState.folded}
      <div transition:slide={foldSlide()}>
        <div class="space-y-4 p-4">
          <div>
            <p class="text-sm font-semibold text-foreground">
              {needsSelection
                ? `${request.workerTitle ?? 'The agent'} needs vision assistance`
                : networkRelated
                  ? 'The image upload or vision response was interrupted'
                  : 'The vision model could not describe this image'}
            </p>
            <p
              class="mt-1.5 max-h-40 overflow-y-auto break-words whitespace-pre-wrap border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-danger"
            >
              {request.error}
            </p>
            <p class="mt-2 text-xs leading-relaxed text-muted">
              {needsSelection
                ? 'Choose a vision-capable model to describe the image. The blocked worker resumes after you continue.'
                : networkRelated
                  ? 'This is usually caused by a slow or unstable connection. Retry allows more upload time; you can also choose another vision model, pick a different image, or continue without the description.'
                  : changed
                    ? 'Retry with the selected vision model, pick a different image, ignore, or type a new message below to steer the agent another way.'
                    : 'Pick a different vision model and retry, pick a different image, ignore, or type a new message below to steer the agent another way.'}
            </p>
          </div>

          <div>
            <p class="mb-1.5 text-[0.6875rem] font-semibold text-dimmed">Change vision model</p>
            <ModelPicker
              {providers}
              {projectId}
              harnessId={visionSelection?.harnessId ?? providers[0]?.harnessId ?? ''}
              providerId={visionSelection?.providerId ?? ''}
              modelId={visionSelection?.modelId ?? ''}
              accountId={visionSelection?.accountId}
              {favoriteModels}
              {recentModels}
              {onRemoveRecent}
              visionOnly
              side="top"
              variant="field"
              disabled={working}
              onSelect={(providerId, modelId, harnessId, accountId) => {
                override = { harnessId, providerId, modelId, accountId }
              }}
              thinkingLevel={visionSelection?.thinkingLevel}
              runtimeSettings={visionSelection ?? undefined}
              onSelectThinking={chooseThinking}
              onSelectRuntime={chooseRuntime}
              {onToggleFavorite}
              {onReorderFavorite}
            />
            <div class="mt-3">
              <Switch
                bind:checked={remember}
                label="Don't ask again"
                aria-label="Don't ask again for worker image model selection"
              />
            </div>
          </div>

          {#if actionError}
            <p class="text-xs text-danger" role="alert">{actionError}</p>
          {/if}
        </div>
      </div>
    {/if}

    {#if !foldState.folded}
      <CardFoot>
        {#snippet left()}
          <CardButton
            label="Ignore"
            title="Ignore and continue without the description"
            icon={CioCheck}
            variant="ghost"
            disabled={working}
            onclick={() => void ignore()}
          />
          {#if request.imageId}
            <CardButton
              label="Pick new image"
              title="Choose a different image and retry the description with it"
              icon={CioImagePlus}
              variant="secondary"
              disabled={working}
              onclick={() => void pickNewImage()}
            />
          {/if}
          {#if request.requestingModel}
            <CardButton
              label="False positive"
              title="{falsePositiveTitle} so the image descriptor is skipped for it"
              icon={CioEye}
              variant="secondary"
              disabled={working}
              onclick={() => void reportFalsePositive()}
            />
          {/if}
        {/snippet}
        {#snippet right()}
          <CardButton
            label={needsSelection
              ? 'Continue worker'
              : changed
                ? 'Retry with this model'
                : networkRelated
                  ? 'Retry with more time'
                  : 'Retry'}
            title={retryTitle}
            icon={working || !visionSelection ? undefined : CioRefresh}
            variant="primary"
            loading={working}
            disabled={working || !visionSelection}
            onclick={() => void retry()}
          />
        {/snippet}
      </CardFoot>
    {/if}
  </CardFrame>
</div>
