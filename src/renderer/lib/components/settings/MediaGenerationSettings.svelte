<script lang="ts">
  import { ExternalLink, KeyRound, Loader2, Trash2 } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import type { MediaProviderId } from '$shared/media-generation'
  import type { MediaGenerationState } from '$shared/ipc-contract'
  import type { AppConfig, AppConfigPatch } from '$shared/types'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import EnumSelect from '../ui/EnumSelect.svelte'

  /**
   * The generation backend: which service produces images, clips and sound.
   *
   * One provider at a time, because one aggregator token already reaches many
   * models. The real choice of model lives on the design assignment, per craft,
   * so this card only answers "who does the app call" and "what token does it
   * use". The token is handed to the main process and never comes back: the
   * renderer only learns whether one is stored.
   */
  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  let generationState = $state<MediaGenerationState | null>(null)
  let loading = $state(true)
  let error = $state('')
  let notice = $state('')
  /** The token being typed. Cleared on save and never populated from stored value. */
  let tokenInput = $state('')
  let saving = $state(false)
  let pendingRemoval = $state(false)
  /**
   * Set when the user has just chosen a provider, and consumed by the token
   * field on mount. Focusing on a page load instead would scroll the settings
   * page to a field nobody asked for.
   */
  let focusTokenOnMount = $state(false)

  const focusTokenField: Attachment<HTMLInputElement> = (element) => {
    if (!focusTokenOnMount) return
    focusTokenOnMount = false
    element.focus()
  }

  const providerId = $derived(config.mediaGeneration.providerId)
  const selectedProvider = $derived(
    generationState?.providers.find((provider) => provider.id === providerId) ?? null
  )

  /** `none` is offered so choosing a backend is reversible without a second control. */
  type ProviderChoice = 'none' | MediaProviderId
  const providerOptions = $derived([
    { id: 'none' as ProviderChoice, label: 'None' },
    ...(generationState?.providers ?? []).map((provider) => ({
      id: provider.id as ProviderChoice,
      label: provider.label,
      hint: provider.description
    }))
  ])

  async function load(): Promise<void> {
    loading = true
    error = ''
    try {
      generationState = await invoke('mediaGeneration:state')
    } catch (loadError) {
      error =
        loadError instanceof Error
          ? loadError.message
          : 'The generation settings could not be loaded.'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void load()
  })

  /**
   * Persist the backend choice. Choosing a provider is the moment the token
   * field appears, and entering a token is the next thing the user has to do,
   * so the field takes focus as it mounts.
   */
  async function selectProvider(choice: ProviderChoice): Promise<void> {
    notice = ''
    const next: MediaProviderId | null = choice === 'none' ? null : choice
    try {
      if (next) focusTokenOnMount = true
      await updateConfig({ mediaGeneration: { providerId: next } })
    } catch (saveError) {
      reportError(saveError, 'The generation backend could not be saved.')
    }
  }

  async function saveToken(): Promise<void> {
    const value = tokenInput.trim()
    const id = providerId
    if (!id || value.length === 0) return
    saving = true
    notice = ''
    try {
      generationState = await invoke('mediaGeneration:setToken', id, value)
      tokenInput = ''
      notice = 'Token saved.'
    } catch (saveError) {
      reportError(saveError, 'The generation token could not be saved.')
    } finally {
      saving = false
    }
  }

  async function removeToken(): Promise<void> {
    const id = providerId
    pendingRemoval = false
    if (!id) return
    notice = ''
    try {
      generationState = await invoke('mediaGeneration:clearToken', id)
    } catch (removeError) {
      reportError(removeError, 'The generation token could not be removed.')
    }
  }
</script>

<div id="settings-block-design-generation" class="rounded-xl border bg-surface p-4">
  <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Generation backend</h3>
  <p class="mt-2 text-xs leading-relaxed text-dimmed">
    The service that makes images, clips and sound when a design or a composition needs them. One
    token reaches many models, and you pick which model each craft uses below. Store your own key:
    it is kept in this device's secure vault, and nothing is generated until you add one.
  </p>

  {#if error}
    <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {/if}

  {#if loading}
    <div class="mt-3 flex items-center gap-2 text-xs text-muted">
      <Loader2 size={14} class="animate-spin" /> Loading generation settings…
    </div>
  {:else if generationState}
    <div class="mt-3 flex flex-wrap items-start gap-3">
      <div class="w-64 shrink-0">
        <span class="block text-xs text-muted">Provider</span>
        <div class="mt-1">
          <EnumSelect
            options={providerOptions}
            value={providerId}
            onChange={(choice) => void selectProvider(choice)}
            placeholder="None"
            ariaLabel="The generation backend"
            title="The service the app calls to generate images, clips and sound"
            disabled={!settingsReady}
          />
        </div>
      </div>
    </div>

    {#if selectedProvider}
      <div class="mt-4 space-y-3 rounded-lg border border-border bg-elevated/40 p-3">
        <p class="text-xs leading-relaxed text-dimmed">{selectedProvider.description}</p>

        <button
          type="button"
          class="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          title={`Open the ${selectedProvider.label} page that issues an API token`}
          aria-label={`Open the ${selectedProvider.label} page that issues an API token`}
          data-external-url={selectedProvider.keyUrl}
          onclick={() => void openInBrowser(selectedProvider.keyUrl)}
        >
          <ExternalLink size={12} /> Get a {selectedProvider.label} token
        </button>

        {#if !generationState.secureStorageAvailable}
          <p class="text-xs text-dimmed">
            This device cannot store credentials securely, so a token cannot be saved here. Enable
            your OS keychain and reopen the app.
          </p>
        {:else}
          <div class="flex flex-wrap items-end gap-2">
            <div class="min-w-0 flex-1">
              <label class="block text-xs text-muted" for="generation-token">API token</label>
              <input
                id="generation-token"
                {@attach focusTokenField}
                class="mt-1 w-full rounded-lg border bg-elevated px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-primary disabled:opacity-60"
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder={generationState.hasToken
                  ? 'Stored. Paste a new one to replace it.'
                  : 'r8_...'}
                bind:value={tokenInput}
                disabled={!settingsReady || saving}
                title={`The ${selectedProvider.label} API token the app uses to generate media`}
                onkeydown={(event) => {
                  if (event.key === 'Enter') void saveToken()
                }}
              />
            </div>
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay disabled:opacity-50"
              disabled={!settingsReady || saving || tokenInput.trim().length === 0}
              title="Save this generation token"
              aria-label="Save this generation token"
              onclick={() => void saveToken()}
            >
              {#if saving}
                <Loader2 size={13} class="animate-spin" />
              {:else}
                <KeyRound size={13} />
              {/if}
              Save
            </button>
            {#if generationState.hasToken}
              <button
                type="button"
                class="flex items-center gap-1.5 rounded-lg border border-danger/30 px-2.5 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                disabled={!settingsReady}
                title="Remove the stored generation token"
                aria-label="Remove the stored generation token"
                onclick={() => {
                  pendingRemoval = true
                }}
              >
                <Trash2 size={13} /> Remove
              </button>
            {/if}
          </div>

          <p
            class="text-xs {generationState.hasToken ? 'text-success' : 'text-dimmed'}"
            role="status"
          >
            {#if notice}
              {notice}
            {:else if generationState.hasToken}
              A token is stored for {selectedProvider.label}.
            {:else}
              No token stored yet.
            {/if}
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<ConfirmDialog
  open={pendingRemoval}
  title="Remove the generation token?"
  confirmLabel="Remove token"
  variant="danger"
  note="Media generation stops until you add a token again."
  onCancel={() => {
    pendingRemoval = false
  }}
  onConfirm={() => void removeToken()}
>
  The stored {selectedProvider?.label ?? 'generation'} token is deleted from this device's vault.
</ConfirmDialog>
