<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { DropdownMenu, Popover } from 'bits-ui'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { Brain, Check, Cpu, Star, UserRound, Zap } from '@lucide/svelte'
  import { isCodeInOvenCustomProviderId } from '$shared/custom-provider-id'
  import { resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { modelKey } from '$lib/model-keys'
  import { peakHoursBadgeFor } from '$shared/peak-hours'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { mergeProviderCatalogEntries, providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import {
    FIRST_RUN_PROVIDER_SEARCH,
    providerConnectFlow
  } from '$lib/stores/provider-connect-flow.svelte'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import type {
    HarnessAccount,
    ProviderCatalog,
    ThinkingLevel,
    ThinkingPreset
  } from '$shared/types'
  import ModelPickerHarnessIcon from './ModelPickerHarnessIcon.svelte'
  import ModelPickerList from './ModelPickerList.svelte'
  import ModelPickerVendorIcons from './ModelPickerVendorIcons.svelte'
  import { findModelEntry, truncateLabel } from './model-picker-helpers'

  interface Props {
    providers: ProviderCatalog[]
    harnessId: string
    providerId: string
    modelId: string
    /** Credential container used by the selected provider. Missing means its default. */
    accountId?: string
    favoriteModels?: string[]
    recentModels?: string[]
    /** True while the picker is open   opening it refreshes the catalog. */
    open?: boolean
    /** True while the thinking-level dropdown is open. Lets a parent open the
     *  thinking selector directly (e.g. from the `/thinking` slash action). */
    thinkingMenuOpen?: boolean
    /** True while the account dropdown is open. Lets a parent open the account
     *  selector directly (e.g. from the `/account` slash action). */
    accountMenuOpen?: boolean
    /** Reports whether the account picker is rendered (more than one account
     *  for the current provider). Lets a parent conditionally surface actions
     *  such as the `/account` slash command. */
    onAccountPickerVisibleChange?: (visible: boolean) => void
    /** Project whose harness catalog this picker displays. When provided, opening
     *  the picker lazily fetches that project's catalog (network only when stale). */
    projectId?: string | null
    /** Restricts the picker to one harness. Unset shows every harness as today. */
    harnessFilter?: string | null
    side?: 'top' | 'bottom'
    disabled?: boolean
    variant?: 'compact' | 'field' | 'action'
    /** Stretch the trigger across the full container width (board/panel layouts). */
    fullWidth?: boolean
    label?: string
    /** Keep the catalog open while toggling several models. */
    multiSelect?: boolean
    /** Harness-scoped model keys selected by a multi-select caller. */
    selectedModelKeys?: string[]
    /** Shows that the selected model is using its fast inference tier. */
    fast?: boolean
    /** When true, only models that report vision capability are shown. */
    visionOnly?: boolean
    /** Current thinking level. Whenever the selected model declares thinking
     *  presets, the trigger shows the level badge and the popover exposes the
     *  presets   no opt-in beyond passing the current value is needed. */
    thinkingLevel?: ThinkingLevel | null
    /** Thinking presets to display. Defaults to the selected model's declared
     *  presets   when the model declares none, thinking controls stay hidden. */
    thinkingPresets?: ThinkingPreset[]
    onSelect: (providerId: string, modelId: string, harnessId: string, accountId?: string) => void
    /** Reports the full account record when the account segment changes. */
    onSelectAccount?: (account: HarnessAccount) => void
    onSelectMultiple?: (modelKeys: string[]) => void
    /** Fired when the thinking level changes   either from an explicit preset
     *  click, or automatically when a newly selected model no longer supports
     *  the previous level. */
    onSelectThinking?: (level: ThinkingLevel) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Removes a model from the caller's recently-used history; when provided,
     *  recent rows show a small "x" next to the favorite star. No confirmation  
     *  removing from history is trivially re-triggered by using the model. */
    onRemoveRecent?: (modelKey: string) => void
    /** Reorders a favorite relative to another favorite; position in display order. */
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    providers,
    harnessId,
    providerId,
    modelId,
    accountId,
    favoriteModels = [],
    recentModels = [],
    open = $bindable(false),
    thinkingMenuOpen = $bindable(false),
    accountMenuOpen = $bindable(false),
    projectId = null,
    harnessFilter = null,
    side = 'top',
    disabled = false,
    variant = 'compact',
    fullWidth = false,
    label,
    multiSelect = false,
    selectedModelKeys = [],
    fast = false,
    visionOnly = false,
    thinkingLevel = null,
    thinkingPresets,
    onSelect,
    onSelectAccount,
    onAccountPickerVisibleChange,
    onSelectMultiple,
    onSelectThinking,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  let pickerList: ModelPickerList | undefined = $state(undefined)
  let accounts = $derived(harnessAccountCache.cached(harnessId) ?? [])
  let accountLoading = $state(false)
  let accountLoadGeneration = 0
  let selectedModelKeysSet = $derived(new Set(selectedModelKeys))
  /** Harness catalogs are app-wide. Keep the union available while a newly
   * opened project's time-budgeted refresh is still returning partial results. */
  let cachedProviders = $derived(providerCatalog.allCached())
  let currentProviders = $derived(
    projectId ? (providerCatalog.cached(projectId) ?? providers) : providers
  )
  /** Current-project entries win when present without dropping harnesses that
   * are still pending from its background catalog enrichment. */
  let displayProviders = $derived(
    mergeProviderCatalogEntries([...cachedProviders, ...providers, ...currentProviders]).filter(
      (provider) => !harnessFilter || provider.harnessId === harnessFilter
    )
  )
  let selectedProvider = $derived(
    displayProviders.find(
      (provider) => provider.id === providerId && provider.harnessId === harnessId
    ) ??
      displayProviders.find((provider) => provider.id === providerId) ??
      displayProviders.find((provider) => provider.models.some((model) => model.id === modelId))
  )
  let selectedModel = $derived(
    selectedProvider?.models.find((model) => model.id === modelId) ??
      displayProviders.flatMap((provider) => provider.models).find((model) => model.id === modelId)
  )
  /**
   * Thinking presets offered by the selected model. Callers may override them
   * (e.g. the composer falls back to the standard presets while the catalog is
   * still cold); otherwise the model's declared presets decide   none declared
   * means the model does not reason and the thinking controls stay hidden.
   */
  let effectiveThinkingPresets = $derived(thinkingPresets ?? selectedModel?.thinkingPresets ?? [])
  /** Thinking controls appear whenever the selected model declares presets
   *  the thinking level depends on the model, not on the caller's opt-in. */
  let supportsThinking = $derived(effectiveThinkingPresets.length > 0)
  /**
   * Fallback "current" level for the trigger when the caller does not track a
   * thinking level yet: the model's declared default (custom providers) or its
   * lowest preset, mirroring what selecting the model would apply.
   */
  let fallbackThinkingLevel = $derived(
    baseUrlProviderStore.defaultThinkingLevel(
      selectedProvider?.harnessId ?? harnessId,
      providerId,
      modelId
    ) ?? resolveDefaultThinkingLevel(effectiveThinkingPresets, undefined, undefined)
  )
  let currentThinkingLabel = $derived(
    effectiveThinkingPresets.find((preset) => preset.id === thinkingLevel)?.label ??
      thinkingLevel ??
      effectiveThinkingPresets.find((preset) => preset.id === fallbackThinkingLevel)?.label ??
      effectiveThinkingPresets[0]?.label ??
      ''
  )
  /** Custom base URL providers never carry accounts: their credentials live in
   *  the provider record itself, so the user always sees the plain provider. */
  let isCustomProvider = $derived(isCodeInOvenCustomProviderId(providerId))
  let providerAccounts = $derived(
    isCustomProvider
      ? []
      : accounts.filter(
          (account) => account.harnessId === harnessId && account.providerId === providerId
        )
  )
  let effectiveAccountId = $derived(
    accountId && providerAccounts.some((account) => account.id === accountId)
      ? accountId
      : ((providerAccounts.find((account) => account.isDefault) ?? providerAccounts[0])?.id ??
          `${harnessId}.default`)
  )
  let selectedAccount = $derived(
    providerAccounts.find((account) => account.id === effectiveAccountId)
  )
  let showAccountPicker = $derived(!multiSelect && providerAccounts.length > 1)

  $effect(() => {
    onAccountPickerVisibleChange?.(showAccountPicker)
  })
  /**
   * Snapshot fallback so the trigger renders instantly, before any harness
   * catalog resolves: the thread's stored harness icon is always available, and
   * the label degrades from the catalog's display name to the raw model id.
   * The catalog enriches these optimistically once it lands.
   */
  let selectedHarnessIcon = $derived(getAgentIcon(harnessId))
  let selectedLabel = $derived(
    multiSelect
      ? (label ??
          (selectedModelKeys.length === 0
            ? 'Select models'
            : `${selectedModelKeys.length} model${selectedModelKeys.length === 1 ? '' : 's'} selected`))
      : (label ?? selectedModel?.name ?? (modelId || 'Model'))
  )
  /** Keep the trigger readable   long names (e.g. Claude Code's default-model
   *  description) would otherwise swallow the composer's bottom bar. */
  let selectedLabelDisplay = $derived(truncateLabel(selectedLabel))
  /** Peak/off-peak state of the currently selected model, for the trigger badge. */
  let selectedPeak = $derived(
    selectedModel ? peakHoursBadgeFor(selectedModel.id, selectedProvider?.id) : null
  )
  /** True while the current project's catalog is being re-probed by the store. */
  let refreshing = $derived(projectId ? providerCatalog.refreshing(projectId) : false)
  /** Visual shell of the trigger   it hosts the model button and, when the
   *  selected model reasons, the thinking-level badge as a split control. */
  let triggerClasses = $derived(
    variant === 'field'
      ? 'flex w-full min-w-0 items-center rounded-lg border bg-elevated transition-colors hover:bg-overlay'
      : variant === 'action'
        ? `flex min-w-0 items-center rounded-lg border bg-elevated transition-colors hover:bg-overlay ${fullWidth ? 'w-full' : ''}`
        : `flex min-w-0 items-center rounded-lg transition-colors hover:bg-elevated ${fullWidth ? 'w-full' : ''}`
  )
  let modelButtonClasses = $derived(
    variant === 'field'
      ? 'flex min-w-0 flex-auto items-center gap-1 px-3 py-2 text-[0.6875rem] text-muted transition-colors hover:text-foreground'
      : variant === 'action'
        ? 'flex min-w-0 flex-auto items-center gap-1 px-3 py-2 text-xs font-semibold text-muted transition-colors hover:text-foreground'
        : 'flex min-w-0 flex-auto items-center gap-1 px-2 py-1.5 text-[0.6875rem] text-muted transition-colors hover:text-foreground'
  )

  function close(): void {
    open = false
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) {
      pickerList?.resetPicker()
      return
    }
    pickerList?.resetPicker()
    void tick().then(() => {
      pickerList?.focusPickerSearch()
      pickerList?.revealSelectedModel()
    })
    // Revalidate exactly once per open. Keeping this outside a reactive effect
    // prevents catalog updates from snapping the user's scroll position back
    // to the selected model.
    if (projectId) void providerCatalog.refresh(projectId)
    void loadAccounts(harnessId, true)
  }

  async function loadAccounts(targetHarnessId: string, force = false): Promise<void> {
    // Callers without a harness yet (e.g. the PR compose picker before any
    // model is chosen) have no account list to fetch, and the main-process
    // validation rejects an empty harness id outright.
    if (!targetHarnessId) return
    const generation = ++accountLoadGeneration
    accountLoading = true
    try {
      await harnessAccountCache.list(targetHarnessId, force)
    } catch {
      // Preserve the last cached account list when a refresh probe fails.
    } finally {
      if (generation === accountLoadGeneration) accountLoading = false
    }
  }

  /**
   * Force every harness's own model catalog to re-fetch from upstream, then
   * re-probe the drivers. This is the explicit user refresh, not a cache
   * revalidation, so it is the only path that pays for the network pass.
   */
  function refreshCatalog(): void {
    if (!projectId) return
    void providerCatalog.refreshFromUpstream(projectId)
  }

  /**
   * Hand the user to the harness's provider list when this picker has nothing
   * to offer. The picker closes first so the connect modal is not opened under
   * an open popover, and the catalog is re-probed once a provider connects.
   */
  function openConnectFlow(): void {
    close()
    providerConnectFlow.open(harnessId, {
      search: FIRST_RUN_PROVIDER_SEARCH,
      onConnected: () => {
        if (projectId) void providerCatalog.refresh(projectId, true)
      }
    })
  }

  async function choose(
    nextProviderId: string,
    nextModelId: string,
    nextHarnessId: string
  ): Promise<void> {
    if (multiSelect) {
      const nextKey = modelKey(nextHarnessId, nextProviderId, nextModelId)
      const nextKeys = selectedModelKeysSet.has(nextKey)
        ? selectedModelKeys.filter((key) => key !== nextKey)
        : [...selectedModelKeys, nextKey]
      onSelectMultiple?.(nextKeys)
      return
    }
    const entry =
      findModelEntry(displayProviders, nextProviderId, nextModelId, harnessId, nextHarnessId) ??
      findModelEntry(cachedProviders, nextProviderId, nextModelId, harnessId, nextHarnessId)
    close()
    let availableAccounts = nextHarnessId === harnessId ? accounts : []
    if (nextHarnessId !== harnessId) {
      try {
        availableAccounts = await harnessAccountCache.list(nextHarnessId)
      } catch {
        availableAccounts = []
      }
    }
    const matchingAccounts = availableAccounts.filter(
      (account) => account.harnessId === nextHarnessId && account.providerId === nextProviderId
    )
    // Custom base URL providers run without accounts: omitting the id keeps the
    // harness-level `${harness}.default` fallback from attaching a random
    // account of the whole harness to the provider's turns.
    const nextAccountId = isCodeInOvenCustomProviderId(nextProviderId)
      ? undefined
      : (matchingAccounts.find((account) => account.id === accountId)?.id ??
        (matchingAccounts.find((account) => account.isDefault) ?? matchingAccounts[0])?.id ??
        `${nextHarnessId}.default`)
    onSelect(nextProviderId, nextModelId, nextHarnessId, nextAccountId)
    if (nextHarnessId !== harnessId) {
      // Invalidate any in-flight loadAccounts for the previous harness before
      // the parent applies the new harness prop. The shared reactive cache now
      // owns the list, so the prop change exposes the warmed accounts directly.
      accountLoadGeneration++
      accountLoading = false
    }
    // Thinking level depends on the model: resolve a level the new model
    // actually offers and surface it right after the model change, so parents
    // never keep a stale level the model no longer supports.
    if (thinkingLevel && entry?.model.thinkingPresets?.length) {
      const defaultLevel = baseUrlProviderStore.defaultThinkingLevel(
        nextHarnessId,
        nextProviderId,
        nextModelId
      )
      const resolved = resolveDefaultThinkingLevel(
        entry.model.thinkingPresets,
        defaultLevel,
        thinkingLevel
      )
      if (resolved && resolved !== thinkingLevel) onSelectThinking?.(resolved)
    }
  }

  function chooseAccount(account: HarnessAccount): void {
    onSelect(providerId, modelId, harnessId, account.id)
    onSelectAccount?.(account)
    // A harness that keeps several credentials in its own store (OpenCode) has
    // to be told which one is active, or the turn would use a stale one.
    void harnessAccountCache
      .activate(account)
      .catch((error) => reportError(error, 'The active account was not switched.'))
  }

  /** Mark an account as its harness's default for this provider. */
  async function setDefaultAccount(account: HarnessAccount): Promise<void> {
    try {
      await harnessAccountCache.setDefault(account)
      await harnessAccountCache.activate(account)
    } catch (setDefaultError) {
      reportError(setDefaultError, 'The default account was not saved.')
    }
  }

  onMount(() => {
    void loadAccounts(harnessId)
  })
</script>

<div class="flex min-w-0">
  <Popover.Root bind:open onOpenChange={handleOpenChange}>
    <div
      class="min-w-0 {triggerClasses}"
      class:pointer-events-none={disabled}
      class:opacity-50={disabled}
    >
      <Popover.Trigger
        class={modelButtonClasses}
        aria-label={`${multiSelect ? 'Select models' : 'Select model'}, currently ${selectedLabel}`}
        title={`${multiSelect ? 'Select models' : 'Select model'}   ${selectedLabel}`}
        {disabled}
      >
        {#if selectedProvider}
          <span class="flex shrink-0 items-center gap-0.5">
            <ModelPickerVendorIcons
              harnessId={selectedProvider.harnessId}
              providerName={selectedProvider.name}
              providerId={selectedProvider.id}
            />
          </span>
        {:else if selectedHarnessIcon}
          <ModelPickerHarnessIcon {harnessId} />
        {:else}
          <Cpu size={12} />
        {/if}
        <span class="min-w-0 flex-auto truncate text-left">{selectedLabelDisplay}</span>
        {#if selectedPeak}
          <span
            class={`shrink-0 rounded-sm px-1 py-px text-[0.4375rem] font-semibold uppercase leading-none ${
              selectedPeak.state === 'peak'
                ? 'bg-amber-500/15 text-amber-500'
                : 'bg-green-500/15 text-green-500'
            }`}
            title={selectedPeak.tooltip}
            aria-label={selectedPeak.tooltip}
          >
            {selectedPeak.triggerLabel}
          </span>
        {/if}
        {#if fast}
          <Zap
            size={11}
            class="shrink-0 text-accent"
            fill="currentColor"
            aria-label="Fast inference"
          />
        {/if}
      </Popover.Trigger>
      {#if supportsThinking}
        <DropdownMenu.Root bind:open={thinkingMenuOpen}>
          <DropdownMenu.Trigger
            class="ml-0.5 mr-1.5 flex min-w-0 shrink items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[0.625rem] text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-default disabled:opacity-50"
            aria-label={`Thinking level: ${currentThinkingLabel}`}
            title="Thinking level"
            {disabled}
          >
            <Brain size={10} class="shrink-0" />
            <span class="min-w-0 truncate capitalize">{currentThinkingLabel}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={4}
              collisionPadding={12}
              onCloseAutoFocus={(event) => event.preventDefault()}
              class="z-90 w-52 rounded-xl border border-border bg-surface p-1 shadow-xl"
            >
              {#each effectiveThinkingPresets as preset (preset.id)}
                {@const active = thinkingLevel === preset.id}
                <DropdownMenu.Item
                  class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated {active
                    ? 'text-primary'
                    : ''}"
                  title={preset.description ?? `Set thinking to ${preset.label}`}
                  onSelect={() => {
                    if (!active) onSelectThinking?.(preset.id as ThinkingLevel)
                  }}
                >
                  {#if active}
                    <Check size={11} class="shrink-0 text-primary" />
                  {:else}
                    <span class="w-[11px] shrink-0" aria-hidden="true"></span>
                  {/if}
                  <span class="flex flex-col">
                    <span class="capitalize">{preset.label}</span>
                    {#if preset.description}
                      <span class="text-[0.625rem] font-normal text-muted"
                        >{preset.description}</span
                      >
                    {/if}
                  </span>
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {/if}
      {#if showAccountPicker}
        <DropdownMenu.Root bind:open={accountMenuOpen}>
          <DropdownMenu.Trigger
            class="ml-0.5 mr-1.5 flex min-w-0 shrink items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[0.625rem] text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-default disabled:opacity-50"
            aria-label={`Account: ${selectedAccount?.label ?? 'Default'}`}
            title="Account"
            {disabled}
          >
            <UserRound size={10} class="shrink-0" />
            <span class="min-w-0 max-w-24 truncate">{selectedAccount?.label ?? 'Default'}</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="start"
              sideOffset={4}
              collisionPadding={12}
              onCloseAutoFocus={(event) => event.preventDefault()}
              class="z-90 w-52 rounded-xl border border-border bg-surface p-1 shadow-xl"
            >
              {#if accountLoading}
                <div class="px-2 py-2 text-xs text-muted">Loading accounts…</div>
              {:else}
                {#each providerAccounts as account (account.id)}
                  {@const active = account.id === effectiveAccountId}
                  <DropdownMenu.Item
                    class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated {active
                      ? 'text-primary'
                      : ''}"
                    title={`Use ${account.label}`}
                    onSelect={() => {
                      if (!active) chooseAccount(account)
                    }}
                  >
                    {#if active}
                      <Check size={11} class="shrink-0 text-primary" />
                    {:else}
                      <span class="w-[11px] shrink-0" aria-hidden="true"></span>
                    {/if}
                    <span class="min-w-0 flex-1 truncate">{account.label}</span>
                    {#if account.isDefault}
                      <span
                        class="shrink-0 rounded bg-raised px-1 text-[0.625rem] font-medium text-muted"
                        title="Default account for this provider"
                      >
                        Default
                      </span>
                    {:else if providerAccounts.length > 1}
                      <button
                        type="button"
                        class="flex size-5 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-accent"
                        title={`Set ${account.label} as the default account for this provider`}
                        aria-label={`Set ${account.label} as the default account for this provider`}
                        onclick={(event) => {
                          event.stopPropagation()
                          void setDefaultAccount(account)
                        }}
                      >
                        <Star size={11} />
                      </button>
                    {/if}
                  </DropdownMenu.Item>
                {/each}
              {/if}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {/if}
    </div>

    <!--
      `z-90`, not `z-70`. This picker is used from inside `DockableModal layer="top"`
      panels (the pull request sheet), which paint at `z-80`. At `z-70` the popover
      opened behind the panel and no model in it could be clicked. `z-90` is the
      app's documented rung for a portaled menu that must clear a `top` panel, and
      the thinking and account menus below are on it for the same reason. Do not
      lower this back: the picker would silently stop working in that panel again.
    -->
    <Popover.Portal>
      <Popover.Content
        {side}
        align="start"
        sideOffset={4}
        collisionPadding={12}
        class="z-90 flex w-64 flex-col overflow-hidden rounded-xl border bg-surface shadow-lg"
        role="dialog"
        aria-label={multiSelect ? 'Select models' : 'Select model'}
        tabindex={-1}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onkeydown={(event: KeyboardEvent) => {
          if (keymapState.matches('palette-close', event)) close()
        }}
      >
        <ModelPickerList
          {displayProviders}
          {cachedProviders}
          {harnessFilter}
          {favoriteModels}
          {recentModels}
          {visionOnly}
          {multiSelect}
          {selectedModelKeys}
          {modelId}
          {providerId}
          {harnessId}
          canRefresh={Boolean(projectId)}
          {refreshing}
          onRefresh={refreshCatalog}
          onChoose={(entry) =>
            void choose(entry.provider.id, entry.model.id, entry.provider.harnessId)}
          onClose={close}
          onOpenConnectFlow={openConnectFlow}
          {onToggleFavorite}
          {onRemoveRecent}
          {onReorderFavorite}
        />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
</div>
