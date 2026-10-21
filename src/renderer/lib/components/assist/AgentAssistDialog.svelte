<script lang="ts">
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { ovens } from '$lib/stores/ovens.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import type {
    HarnessAccount,
    ModelRuntimeSettings,
    PermissionLevel,
    ThinkingLevel,
    ThreadSettings
  } from '$shared/types'
  import Modal from '../ui/Modal.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import AgentAssistOvenField from './AgentAssistOvenField.svelte'
  import AgentAssistPermissionField from './AgentAssistPermissionField.svelte'
  import AgentAssistScopeField from './AgentAssistScopeField.svelte'
  import type { AgentAssistDelivery, AgentAssistRequest } from './agent-assist-store.svelte'
  import { runAgentAssist } from './agent-assist-run'

  /**
   * The one setup every "with agent" control goes through.
   *
   * A surface names the work and hands over a brief; this decides where and how
   * it runs. The two send actions are the whole point of it being a dialog:
   * `Proceed immediately` starts the agent with the confirmed configuration,
   * `Review prompt` opens the same thread with the brief left in the composer,
   * so a user who wants to change the wording before sending is not forced to
   * retype it. Nothing is created until one of them is confirmed.
   */
  interface Props {
    request: AgentAssistRequest
    onClose: () => void
  }

  let { request, onClose }: Props = $props()

  /**
   * The configuration this dialog will hand over.
   *
   * Seeded from the user's last thread so the common case needs no picks, but
   * every field the pickers own is stated here explicitly: the thread this
   * dialog mints takes these values and never inherits a flag (an Assignment
   * or Achievement switch, a chat's file-system mode) from whatever thread the
   * user happened to be reading. Permission always starts at auto review, so
   * full access is a deliberate second choice rather than an inherited one.
   */
  let settings = $state<ThreadSettings>({
    ...threadSettings.lastUsed,
    ovenId: threadSettings.lastUsed.ovenId ?? LOCAL_OVEN_ID,
    permissionLevel: 'auto_review',
    assignmentMode: false,
    loopMode: false,
    fileSystemMode: false
  })
  // The dialog mounts per request, so the request's own scope is the seed this
  // instance starts from; a later request mounts a fresh dialog.
  // svelte-ignore state_referenced_locally
  let scopeBucketId = $state<string | null>(request.scopeBucketId)
  let busy = $state(false)
  let pendingDelivery = $state<AgentAssistDelivery | null>(null)
  let errorMessage = $state('')

  const providers = $derived(
    providerCatalog.cached(request.projectId) ?? providerCatalog.allCached()
  )
  const unavailableHarnessIds = $derived(
    settings.ovenId && settings.ovenId !== LOCAL_OVEN_ID
      ? ovens.unavailableHarnesses(settings.ovenId)
      : null
  )
  const unavailableHarnessReason = $derived.by(() => {
    const ovenId = settings.ovenId
    if (!ovenId || ovenId === LOCAL_OVEN_ID) return null
    const name = ovens.identity(ovenId)?.name
    return name ? `Not installed on ${name}` : 'Not installed on this Oven'
  })
  const modelUnavailable = $derived(unavailableHarnessIds?.has(settings.harnessId) === true)
  const canSubmit = $derived(Boolean(settings.modelId) && !modelUnavailable && !busy)
  const lockedScope = $derived(
    request.scopeBucketId === null
      ? null
      : (scopeState.boards
          .get(request.projectId)
          ?.buckets.find((bucket) => bucket.id === request.scopeBucketId) ?? null)
  )

  onMount(() => {
    void scopeState.ensureBoardLoaded(request.projectId)
    void ovens.ensure()
    // A project bound to an Oven hands its machine to the handoff unless the
    // user already has a remembered one.
    void invoke('project:get', request.projectId)
      .then((project) => {
        if (!project?.ovenId || settings.ovenId !== LOCAL_OVEN_ID) return
        settings = { ...settings, ovenId: project.ovenId }
        void ovens.ensureInventory(project.ovenId)
      })
      .catch(() => undefined)
    if (settings.ovenId && settings.ovenId !== LOCAL_OVEN_ID) {
      void ovens.ensureInventory(settings.ovenId)
    }
  })

  function selectModel(
    providerId: string,
    modelId: string,
    harnessId: string,
    accountId?: string
  ): void {
    settings = {
      ...settings,
      providerId,
      modelId,
      harnessId,
      ...(accountId ? { accountId } : {})
    }
  }

  function selectAccount(account: HarnessAccount): void {
    settings = { ...settings, accountId: account.id }
  }

  function selectThinking(level: ThinkingLevel): void {
    settings = { ...settings, thinkingLevel: level }
  }

  function selectPermission(level: PermissionLevel): void {
    settings = { ...settings, permissionLevel: level }
  }

  function selectRuntime(runtime: ModelRuntimeSettings): void {
    settings = { ...settings, ...runtime }
  }

  function selectOven(ovenId: string): void {
    const next: ThreadSettings = { ...settings, ovenId }
    if (ovenId === LOCAL_OVEN_ID) delete next.ovenPath
    settings = next
    if (ovenId !== LOCAL_OVEN_ID) void ovens.ensureInventory(ovenId)
  }

  /**
   * Exactly the values on screen, and nothing carried over from another thread.
   *
   * The components that build the thread read this object directly, so a field
   * shown here can never disagree with the run it starts.
   */
  function confirmedSettings(): ThreadSettings {
    return {
      harnessId: settings.harnessId,
      providerId: settings.providerId,
      modelId: settings.modelId,
      thinkingLevel: settings.thinkingLevel,
      permissionLevel: settings.permissionLevel,
      assignmentMode: false,
      loopMode: false,
      fileSystemMode: false,
      ovenId: settings.ovenId ?? LOCAL_OVEN_ID,
      ...(settings.ovenPath ? { ovenPath: settings.ovenPath } : {}),
      ...(settings.accountId ? { accountId: settings.accountId } : {}),
      ...(settings.inferenceMode ? { inferenceMode: settings.inferenceMode } : {}),
      ...(settings.contextWindow ? { contextWindow: settings.contextWindow } : {})
    }
  }

  async function submit(delivery: AgentAssistDelivery): Promise<void> {
    if (!canSubmit) return
    busy = true
    pendingDelivery = delivery
    errorMessage = ''
    try {
      await runAgentAssist(request, { settings: confirmedSettings(), scopeBucketId }, delivery)
      onClose()
    } catch (error) {
      errorMessage =
        error instanceof Error && error.message
          ? error.message
          : 'The agent handoff could not be started.'
    } finally {
      busy = false
      pendingDelivery = null
    }
  }

  /**
   * Land the cursor on the field the dialog is waiting for.
   *
   * With no model chosen both send actions are disabled, so the panel's own rule
   * (first text field, else the primary action) has nothing to focus and leaves
   * the keyboard on the document. The first thing the user has to answer is the
   * model, so that is what gets the focus until a send action can take it.
   */
  function claimInitialFocus(panel: HTMLElement): boolean {
    if (canSubmit) return false
    const field = panel.querySelector<HTMLElement>('[data-assist-model] button')
    if (!field) return false
    field.focus({ preventScroll: true })
    return true
  }
</script>

<Modal open title={request.title} size="lg" {onClose} {claimInitialFocus}>
  <div class="space-y-4">
    <p class="text-xs leading-relaxed text-muted">{request.summary}</p>

    <section class="space-y-1.5" data-assist-model>
      <h2 class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">Model</h2>
      <div class="flex items-stretch gap-2">
        <div class="min-w-0 flex-1">
          <ModelPicker
            {providers}
            projectId={request.projectId}
            harnessId={settings.harnessId}
            providerId={settings.providerId}
            modelId={settings.modelId}
            accountId={settings.accountId}
            {unavailableHarnessIds}
            {unavailableHarnessReason}
            thinkingLevel={settings.thinkingLevel}
            runtimeSettings={settings}
            onSelect={selectModel}
            onSelectAccount={selectAccount}
            onSelectThinking={selectThinking}
            onSelectRuntime={selectRuntime}
            variant="field"
            side="bottom"
            fullWidth
          />
        </div>
        <div class="flex shrink-0 items-center border bg-elevated">
          <AgentAssistPermissionField
            value={settings.permissionLevel}
            onSelect={selectPermission}
          />
        </div>
      </div>
    </section>

    <section class="space-y-1.5">
      <h2 class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">Oven</h2>
      <AgentAssistOvenField value={settings.ovenId ?? LOCAL_OVEN_ID} onSelect={selectOven} />
      <p class="text-[0.625rem] leading-relaxed text-dimmed">
        The machine the agent runs on. A remote Oven works from its own isolated checkout of this
        project.
      </p>
    </section>

    <section class="space-y-1.5">
      <h2 class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">Scope</h2>
      {#if request.scopeLocked}
        <div class="flex items-center gap-2 border bg-elevated px-3 py-2">
          <CioFolder size={13} class="shrink-0 text-muted" />
          <span class="min-w-0 flex-1 truncate text-xs text-foreground">
            {lockedScope?.name ?? 'This checkout'}
          </span>
          <span class="shrink-0 text-[0.625rem] text-dimmed">This checkout</span>
        </div>
        <p class="text-[0.625rem] leading-relaxed text-dimmed">
          This action works on the checkout it was started from, so the scope is fixed.
        </p>
      {:else}
        <AgentAssistScopeField
          projectId={request.projectId}
          value={scopeBucketId}
          newCheckoutLabel={request.newCheckout?.title}
          onSelect={(bucketId) => (scopeBucketId = bucketId)}
        />
        <p class="text-[0.625rem] leading-relaxed text-dimmed">
          {scopeBucketId === null && request.newCheckout
            ? `A fresh checkout named ${request.newCheckout.title} is created first; the agent never touches your open working tree.`
            : 'The agent works in this checkout. Pick “New isolated checkout” to keep the run away from your working tree.'}
        </p>
      {/if}
    </section>

    {#if modelUnavailable}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        {settings.harnessId} is not installed on this Oven. Choose a model that runs there.
      </p>
    {/if}
    {#if errorMessage}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{errorMessage}</p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay disabled:cursor-not-allowed disabled:opacity-50"
      disabled={busy}
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-2 border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay disabled:cursor-not-allowed disabled:opacity-50"
      title="Open the thread with the brief ready to edit and send yourself"
      disabled={!canSubmit}
      onclick={() => void submit('draft')}
    >
      {#if pendingDelivery === 'draft'}<CioSpinner size={13} class="animate-spin" />{/if}
      <span>Review prompt</span>
    </button>
    <button
      type="button"
      data-modal-primary
      class="inline-flex items-center gap-2 bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      title="Start the agent now with this model, thinking level, Oven and scope"
      disabled={!canSubmit}
      onclick={() => void submit('immediate')}
    >
      {#if pendingDelivery === 'immediate'}<CioSpinner size={13} class="animate-spin" />{/if}
      <span>Proceed immediately</span>
    </button>
  {/snippet}
</Modal>
