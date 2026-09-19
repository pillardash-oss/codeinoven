<script lang="ts">
  import { ChevronLeft, Loader2, Sparkles } from '@lucide/svelte'
  import type {
    ProviderCatalog,
    ThreadSettings,
    ThinkingLevel,
    UtilitySetupReport
  } from '$shared/types'
  import ModelPicker from '../shared/ModelPicker.svelte'

  interface Props {
    setupPreset: string | null
    isNative: boolean
    hasDraftId: boolean
    isAppOwned: boolean
    saving: boolean
    agentReport: UtilitySetupReport | null
    agentSettings: ThreadSettings | null
    agentProviders: ProviderCatalog[]
    agentProjectId: string
    canRunAgentSetup: boolean
    canImportPlugin: boolean
    onBack: () => void
    onClose: () => void
    onRunAgentSetup: () => void
    onImportPlugin: () => void
    onRequestDelete: () => void
    onSelectAgentModel: (
      providerId: string,
      modelId: string,
      harnessId: string,
      accountId?: string
    ) => void
    onSelectAgentThinking: (level: ThinkingLevel) => void
  }

  let {
    setupPreset,
    isNative,
    hasDraftId,
    isAppOwned,
    saving,
    agentReport,
    agentSettings,
    agentProviders,
    agentProjectId,
    canRunAgentSetup,
    canImportPlugin,
    onBack,
    onClose,
    onRunAgentSetup,
    onImportPlugin,
    onRequestDelete,
    onSelectAgentModel,
    onSelectAgentThinking
  }: Props = $props()

  const showBack = $derived(!isNative && !hasDraftId && setupPreset !== null)
</script>

<div class="flex w-full items-center justify-between gap-2">
  <div>
    {#if showBack}
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground"
        type="button"
        onclick={onBack}
      >
        <ChevronLeft size={14} /> Back
      </button>
    {/if}
  </div>
  <div class="flex items-center gap-2">
    {#if setupPreset === 'agent'}
      <button
        class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
        type="button"
        onclick={onClose}
      >
        {agentReport ? 'Done' : 'Cancel'}
      </button>
      {#if !agentReport}
        {#if agentSettings}
          <ModelPicker
            providers={agentProviders}
            projectId={agentProjectId}
            harnessId={agentSettings.harnessId}
            providerId={agentSettings.providerId}
            modelId={agentSettings.modelId}
            accountId={agentSettings.accountId}
            thinkingLevel={agentSettings.thinkingLevel}
            variant="action"
            side="top"
            disabled={saving}
            onSelect={onSelectAgentModel}
            onSelectThinking={onSelectAgentThinking}
          />
        {/if}
        <button
          class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="button"
          disabled={saving || !canRunAgentSetup}
          onclick={onRunAgentSetup}
        >
          {#if saving}<Loader2 size={13} class="animate-spin" />{:else}<Sparkles size={13} />{/if}
          {saving ? 'Setting up…' : 'Set up utility'}
        </button>
      {/if}
    {:else if setupPreset === 'plugin-bundle'}
      <button
        class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
        type="button"
        onclick={onClose}
      >
        Cancel
      </button>
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
        type="button"
        disabled={saving || !canImportPlugin}
        onclick={onImportPlugin}
      >
        {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
        Install plugin
      </button>
    {:else}
      <button
        class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
        type="button"
        onclick={onClose}
      >
        {hasDraftId || isNative || setupPreset !== null ? 'Cancel' : 'Close'}
      </button>
      {#if (hasDraftId || isNative) && !isAppOwned}
        <button
          class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          type="button"
          disabled={saving}
          onclick={onRequestDelete}
        >
          {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
          Delete
        </button>
      {/if}
      {#if hasDraftId || isNative || setupPreset !== null}
        <button
          class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="submit"
          form="utility-editor-form"
          disabled={saving}
        >
          {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
          {isNative ? 'Save changes' : 'Save utility'}
        </button>
      {/if}
    {/if}
  </div>
</div>
