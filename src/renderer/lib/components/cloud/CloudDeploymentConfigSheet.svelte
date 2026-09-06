<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity'
  import { CheckCircle2, Cloud, Loader2, Search } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { invoke } from '$lib/ipc.svelte'
  import { cloudAccountsState } from '$lib/stores/cloud-accounts.svelte'
  import SideSheet from '../ui/SideSheet.svelte'
  import Switch from '../ui/Switch.svelte'
  import CloudProviderIcon from './icons/CloudProviderIcon.svelte'
  import {
    CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS,
    type CloudDeploymentConfig,
    type CloudDeploymentContainer,
    type CloudDeploymentProviderKind
  } from '$shared/types'

  interface Props {
    open: boolean
    /** Project to attach accounts to. Optional: when absent (settings context)
     *  the sheet only creates a global provider account and never attaches it. */
    projectId?: string
    onClose: () => void
    /** The flow the sheet opens in. */
    initialMode?: Mode
    /** Container being edited (pre-filled), or null to add new. */
    editingContainer?: CloudDeploymentContainer | null
    /** Called after a successful save so the caller can refresh its view. */
    onSaved?: () => void
  }

  let {
    open,
    projectId,
    onClose,
    initialMode = 'provider',
    editingContainer = null,
    onSaved
  }: Props = $props()

  type Mode = 'provider' | 'container'

  /** True when a project context is present (settings page has none). */
  const hasProject = $derived(projectId !== undefined)

  /** Provider kinds this sheet can configure: Coolify (working) plus the stubs. */
  const PROVIDER_KINDS: CloudDeploymentProviderKind[] = [
    'coolify',
    'netlify',
    'railway',
    'vercel',
    'dokploy'
  ]

  const WORKING_KIND: CloudDeploymentProviderKind = 'coolify'

  const PROVIDER_DISPLAY_NAMES: Readonly<Record<CloudDeploymentProviderKind, string>> = {
    coolify: 'Coolify',
    netlify: 'Netlify',
    railway: 'Railway',
    vercel: 'Vercel',
    dokploy: 'Dokploy',
    custom: 'Custom'
  }

  let mode = $state<Mode>('provider')
  let selectedKind = $state<CloudDeploymentProviderKind | null>(null)
  // "create" path: make a brand-new global account.
  let createMode = $state<'create' | 'reuse'>('create')
  let accountLabel = $state('')
  let baseUrl = $state('')
  let token = $state('')
  // "reuse" path: pick an existing global account to attach.
  let selectedExistingAccountId = $state('')
  let containerProviderKind = $state<CloudDeploymentProviderKind | ''>('')
  let containerId = $state('')
  let containerLabel = $state('')
  let containerSearch = $state('')
  let availableContainers = $state<CloudDeploymentContainer[]>([])
  let availableLoading = $state(false)
  let availableError = $state('')
  let saving = $state(false)
  let error = $state('')
  /** The project's current config, loaded on open. */
  let config = $state<CloudDeploymentConfig | null>(null)
  /** Container ids selected in the picker for a batch add. */
  let selectedContainerIds = new SvelteSet<string>()

  /** Providers that have at least one account attached to this project — only
   *  these can have containers monitored, since resolving needs an account. */
  let attachedProviderKinds = $derived(
    (
      Object.entries(config?.project.providerAccounts ?? {}) as Array<
        [CloudDeploymentProviderKind, { attachedAccountIds?: string[] }]
      >
    )
      .filter(([, association]) => (association.attachedAccountIds?.length ?? 0) > 0)
      .map(([kind]) => kind)
  )

  /** Only providers with an account attached to this project can host monitored
   *  containers, since resolving a container requires an account credential. */
  let canAddContainer = $derived(attachedProviderKinds.length > 0)

  let containerProviders = $derived(
    PROVIDER_KINDS.filter((kind) => attachedProviderKinds.includes(kind))
  )

  let filteredAvailable = $derived(
    availableContainers.filter((container) => {
      const query = containerSearch.trim().toLowerCase()
      if (query === '') return true
      // Match against the provider label, id, url, and any custom label this
      // project has already assigned to the same container id.
      const known = config?.project.containers.find(
        (mapping) => mapping.id === container.id && mapping.providerKind === container.providerKind
      )
      const haystack = [
        container.label,
        container.id,
        container.url ?? '',
        container.project ?? '',
        known?.label ?? ''
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
  )

  let baseUrlValidation = $derived(validateBaseUrl(baseUrl))

  let existingAccountsForKind = $derived(
    selectedKind === null ? [] : cloudAccountsState.accountsByProvider(selectedKind)
  )

  let canSave = $derived(
    mode === 'provider'
      ? selectedKind === WORKING_KIND &&
          (createMode === 'create'
            ? accountLabel.trim() !== '' &&
              baseUrl.trim() !== '' &&
              baseUrlValidation.ok &&
              token.trim() !== ''
            : selectedExistingAccountId !== '')
      : containerProviderKind !== '' && (selectedContainerIds.size > 0 || containerId.trim() !== '')
  )

  /** Accounts this project has attached for the currently selected provider. */
  const attachedForSelectedKind = $derived(
    selectedKind === null
      ? []
      : (config?.project.providerAccounts?.[selectedKind]?.attachedAccountIds ?? [])
  )

  // Reset every field when the sheet reopens so no stale value leaks across uses.
  function resetSheet(): void {
    mode = initialMode
    selectedKind = null
    createMode = 'create'
    accountLabel = ''
    baseUrl = ''
    token = ''
    selectedExistingAccountId = ''
    if (editingContainer) {
      containerProviderKind = editingContainer.providerKind
      containerId = editingContainer.id
      containerLabel = editingContainer.label
    } else {
      containerProviderKind = ''
      containerId = ''
      containerLabel = ''
    }
    containerSearch = ''
    availableContainers = []
    availableLoading = false
    availableError = ''
    selectedContainerIds.clear()
    config = null
    error = ''
    saving = false
  }

  $effect(() => {
    if (!open) return
    resetSheet()
    void cloudAccountsState.load()
    if (projectId) {
      void invoke('cloudDeploy:getConfig', projectId)
        .then((loaded) => {
          config = loaded
        })
        .catch(() => undefined)
    }
  })

  function selectProvider(kind: CloudDeploymentProviderKind): void {
    error = ''
    if (CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS.includes(kind)) {
      const name = PROVIDER_DISPLAY_NAMES[kind]
      toast.message(`${name} isn't available yet`, {
        description: 'This provider will be supported in a future update.'
      })
      return
    }
    selectedKind = kind
    createMode = 'create'
    accountLabel = ''
    baseUrl = ''
    token = ''
    selectedExistingAccountId = ''
  }

  function emptyConfig(projectIdValue: string): CloudDeploymentConfig {
    return {
      version: 3,
      projectId: projectIdValue,
      project: { providers: [], containers: [] },
      updatedAt: Date.now()
    }
  }

  function resetForm(): void {
    selectedKind = null
    createMode = 'create'
    accountLabel = ''
    baseUrl = ''
    token = ''
    selectedExistingAccountId = ''
    containerProviderKind = ''
    containerId = ''
    containerLabel = ''
    containerSearch = ''
    availableContainers = []
    availableError = ''
    selectedContainerIds.clear()
    error = ''
  }

  /** Set which attached account is active for a provider within the project. */
  async function setActive(kind: CloudDeploymentProviderKind, accountId: string): Promise<void> {
    if (!projectId) return
    saving = true
    error = ''
    try {
      config = await invoke('cloudDeploy:setActiveAccount', projectId, kind, accountId)
      toast.success('Switched the active account.')
    } catch (saveError) {
      error = saveError instanceof Error ? saveError.message : 'The account could not be switched.'
    } finally {
      saving = false
    }
  }

  async function saveProvider(): Promise<void> {
    if (selectedKind !== WORKING_KIND) return
    saving = true
    error = ''
    try {
      if (createMode === 'create') {
        const validation = validateBaseUrl(baseUrl)
        if (!validation.ok) {
          error = validation.reason ?? 'Enter a valid Coolify base URL.'
          return
        }
        if (token.trim() === '') {
          error = 'Enter your Coolify API token.'
          return
        }
        if (accountLabel.trim() === '') {
          error = 'Enter a name for this account.'
          return
        }
        // Create the global account (token vaulted by account id), then attach
        // it to the project when a project context is present.
        const account = await cloudAccountsState.createAccount(
          selectedKind,
          accountLabel.trim(),
          token.trim(),
          validation.baseUrl ?? undefined
        )
        if (projectId) {
          config = await cloudAccountsState.attachAccount(projectId, selectedKind, account.id)
        }
        toast.success(`Created “${account.label}”.`)
      } else {
        if (!projectId) {
          error = 'This flow requires a project context.'
          return
        }
        if (selectedExistingAccountId === '') {
          error = 'Choose an existing provider account to attach.'
          return
        }
        config = await cloudAccountsState.attachAccount(
          projectId,
          selectedKind,
          selectedExistingAccountId
        )
        const account = cloudAccountsState.accountById(selectedExistingAccountId)
        toast.success(`Attached “${account?.label ?? 'provider account'}”.`)
      }
      resetForm()
      onClose()
      onSaved?.()
    } catch (saveError) {
      error =
        saveError instanceof Error ? saveError.message : 'The provider could not be configured.'
    } finally {
      saving = false
    }
  }

  async function loadAvailableContainers(): Promise<void> {
    if (!projectId || containerProviderKind === '') return
    availableLoading = true
    availableError = ''
    availableContainers = []
    containerId = ''
    containerLabel = ''
    selectedContainerIds.clear()
    try {
      const result = await invoke(
        'cloudDeploy:availableContainers',
        projectId,
        containerProviderKind
      )
      if (Array.isArray(result)) {
        availableContainers = result
      } else {
        availableError = result.accessError
      }
    } catch (loadError) {
      availableError =
        loadError instanceof Error ? loadError.message : 'Containers could not be loaded.'
    } finally {
      availableLoading = false
    }
  }

  /** Toggle a container's selection for a batch add. */
  function toggleContainer(container: CloudDeploymentContainer): void {
    if (selectedContainerIds.has(container.id)) selectedContainerIds.delete(container.id)
    else selectedContainerIds.add(container.id)
    error = ''
  }

  async function saveContainer(): Promise<void> {
    if (containerProviderKind === '') return
    if (!projectId) return
    if (editingContainer) {
      const newId = containerId.trim()
      const newLabel = containerLabel.trim() || newId
      if (newId === '') {
        error = 'Enter the container ID.'
        return
      }
      saving = true
      error = ''
      try {
        config = await invoke(
          'cloudDeploy:updateContainer',
          projectId,
          editingContainer.providerKind,
          editingContainer.id,
          {
            ...(newLabel !== editingContainer.label ? { label: newLabel } : {}),
            ...(newId !== editingContainer.id ? { id: newId } : {})
          }
        )
        toast.success('Container updated.')
        resetForm()
        onClose()
        onSaved?.()
      } catch (saveError) {
        error =
          saveError instanceof Error ? saveError.message : 'The container could not be updated.'
      } finally {
        saving = false
      }
      return
    }
    if (!attachedProviderKinds.includes(containerProviderKind)) {
      error = `Attach a ${PROVIDER_DISPLAY_NAMES[containerProviderKind]} account to this project first.`
      return
    }
    const manualId = containerId.trim()
    const manualLabel = containerLabel.trim() || manualId
    const selected = availableContainers.filter((container) =>
      selectedContainerIds.has(container.id)
    )
    if (selected.length === 0 && manualId === '') {
      error = 'Select one or more containers to add.'
      return
    }
    saving = true
    error = ''
    try {
      let current =
        config ?? (await invoke('cloudDeploy:getConfig', projectId)) ?? emptyConfig(projectId)
      if (current.version !== 3) {
        current = emptyConfig(projectId)
      }
      if (!current.project.providers.includes(containerProviderKind)) {
        current = {
          ...current,
          project: {
            ...current.project,
            providers: [...current.project.providers, containerProviderKind]
          }
        }
      }
      const now = Date.now()
      const existingIds = new Set(
        current.project.containers
          .filter((mapping) => mapping.providerKind === containerProviderKind)
          .map((mapping) => mapping.id)
      )
      const additions: CloudDeploymentContainer[] = []
      for (const container of selected) {
        if (existingIds.has(container.id)) continue
        additions.push({
          id: container.id,
          label: container.label,
          providerKind: containerProviderKind,
          status: 'unknown',
          ...(container.project ? { project: container.project } : {}),
          createdAt: now,
          updatedAt: now
        })
      }
      if (manualId !== '' && !existingIds.has(manualId)) {
        additions.push({
          id: manualId,
          label: manualLabel,
          providerKind: containerProviderKind,
          status: 'unknown',
          createdAt: now,
          updatedAt: now
        })
      }
      if (additions.length === 0) {
        error = 'The selected containers are already configured for this provider.'
        return
      }
      const updated: CloudDeploymentConfig = {
        ...current,
        project: {
          ...current.project,
          containers: [...current.project.containers, ...additions]
        },
        updatedAt: now
      }
      config = await invoke('cloudDeploy:saveConfig', projectId, updated)
      toast.success(`Added ${additions.length} container${additions.length === 1 ? '' : 's'}.`)
      resetForm()
      onClose()
      onSaved?.()
    } catch (saveError) {
      error = saveError instanceof Error ? saveError.message : 'The container could not be added.'
    } finally {
      saving = false
    }
  }

  // ─── Base URL validation (mirrors src/main/providers/base-url.ts) ────────────
  // Enforces the CODEINOVEN_COOLIFY_BASE_URL contract: an explicit, verified URL
  // supplied by the user; localhost permitted only in development; no invented
  // or reserved placeholder hosts. Mirrored here so the sheet gives immediate
  // inline feedback without reaching into main-process code.

  interface BaseUrlValidation {
    ok: boolean
    baseUrl: string | null
    reason?: string
  }

  const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])
  const PLACEHOLDER_HOSTS = new Set(['example.com', 'example.net', 'example.org', 'example.edu'])
  const PLACEHOLDER_SUFFIXES = ['.example', '.invalid', '.localhost', '.test', '.local']

  function isLocalhostHostname(hostname: string): boolean {
    return LOCALHOST_HOSTNAMES.has(hostname)
  }

  function isPrivateIpAddress(hostname: string): boolean {
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname)
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
      if ([a, b, Number(ipv4[3]), Number(ipv4[4])].some((part) => part > 255)) return true
      if (a === 10) return true
      if (a === 172 && b >= 16 && b <= 31) return true
      if (a === 192 && b === 168) return true
      if (a === 169 && b === 254) return true
      return a === 0 || a === 127
    }
    if (!hostname.includes(':')) return false
    return hostname === '0:0:0:0:0:0:0:1' || hostname.startsWith('fc') || hostname.startsWith('fd')
  }

  function isInventedHost(hostname: string): boolean {
    if (isPrivateIpAddress(hostname)) return true
    for (const host of PLACEHOLDER_HOSTS) {
      if (hostname === host || hostname.endsWith(`.${host}`)) return true
    }
    for (const suffix of PLACEHOLDER_SUFFIXES) {
      if (hostname.endsWith(suffix)) return true
    }
    return !hostname.includes('.')
  }

  function validateBaseUrl(raw: string): BaseUrlValidation {
    const development = import.meta.env.DEV
    const trimmed = raw.trim()
    if (trimmed === '') {
      return { ok: false, baseUrl: null, reason: 'Enter the Coolify base URL.' }
    }
    if (trimmed.length > 2048) {
      return { ok: false, baseUrl: null, reason: 'must be at most 2048 characters' }
    }
    let parsed: URL
    try {
      parsed = new URL(trimmed)
    } catch {
      return { ok: false, baseUrl: null, reason: 'must be an absolute URL with a host' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, baseUrl: null, reason: 'must use http or https' }
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return { ok: false, baseUrl: null, reason: 'must not contain credentials' }
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      return { ok: false, baseUrl: null, reason: 'must be a base URL without a query or fragment' }
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
    const normalizedBaseUrl = parsed.href.replace(/\/+$/u, '')
    if (isLocalhostHostname(hostname)) {
      if (!development) {
        return {
          ok: false,
          baseUrl: null,
          reason: 'localhost is only permitted in development'
        }
      }
      return { ok: true, baseUrl: normalizedBaseUrl }
    }
    if (parsed.protocol !== 'https:') {
      return { ok: false, baseUrl: null, reason: 'non-localhost hosts must use https' }
    }
    if (isInventedHost(hostname)) {
      return {
        ok: false,
        baseUrl: null,
        reason: 'host looks invented or is a reserved placeholder'
      }
    }
    return { ok: true, baseUrl: normalizedBaseUrl }
  }
</script>

<SideSheet
  {open}
  width="max-w-md"
  title={mode === 'provider' ? 'Add provider' : 'Add container'}
  {onClose}
>
  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-3">
      <p class="min-w-0 flex-1 truncate text-[0.6875rem] text-dimmed">
        {#if mode === 'provider'}
          Accounts are stored securely in your system keychain and can be reused across projects.
        {:else}
          Container mappings are saved to this project's deployment config.
        {/if}
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="flex h-9 items-center justify-center gap-1.5 rounded-lg border bg-elevated px-4 text-xs font-medium hover:bg-overlay"
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          disabled={!canSave || saving}
          onclick={() => void (mode === 'provider' ? saveProvider() : saveContainer())}
        >
          {#if saving}
            <Loader2 size={13} class="animate-spin" />
          {/if}
          {mode === 'provider'
            ? 'Save provider'
            : selectedContainerIds.size > 1
              ? `Add ${selectedContainerIds.size} containers`
              : 'Add container'}
        </button>
      </div>
    </div>
  {/snippet}

  <div
    class="mb-4 flex items-center justify-between gap-3 rounded-lg border bg-elevated px-3 py-2.5"
  >
    <div class="min-w-0">
      <p class="text-xs font-medium">{mode === 'provider' ? 'Add provider' : 'Add container'}</p>
      <p class="text-[0.6875rem] text-muted">
        {mode === 'provider'
          ? 'Create a reusable account or attach an existing one.'
          : 'Attach a container to a configured provider.'}
      </p>
    </div>
    {#if hasProject}
      <Switch
        checked={mode === 'container'}
        onchange={(v) => {
          mode = v ? 'container' : 'provider'
          error = ''
        }}
        aria-label="Toggle between adding a provider and adding a container"
      />
    {/if}
  </div>

  {#if mode === 'provider'}
    <div class="space-y-4">
      <div class="space-y-2">
        {#each PROVIDER_KINDS as kind (kind)}
          {@const isWorking = kind === WORKING_KIND}
          {@const isStub = CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS.includes(kind)}
          {@const isSelected = selectedKind === kind}
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors {isSelected
              ? 'border-primary bg-raised'
              : 'hover:bg-raised'}"
            onclick={() => selectProvider(kind)}
            title={isStub
              ? `${PROVIDER_DISPLAY_NAMES[kind]} isn't available yet`
              : `Configure ${PROVIDER_DISPLAY_NAMES[kind]}`}
          >
            <span class="flex min-w-0 items-center gap-2.5">
              <CloudProviderIcon
                providerKind={kind}
                size={15}
                class="shrink-0 text-dimmed"
                title={PROVIDER_DISPLAY_NAMES[kind]}
              />
              <span class="min-w-0">
                <span class="block truncate text-xs font-medium">
                  {PROVIDER_DISPLAY_NAMES[kind]}
                </span>
                <span class="block text-[0.6875rem] text-muted">
                  {isWorking ? 'Available' : isStub ? 'Not implemented yet' : ''}
                </span>
              </span>
            </span>
            {#if isSelected}
              <CheckCircle2 size={15} class="shrink-0 text-primary" />
            {/if}
          </button>
        {/each}
      </div>

      {#if selectedKind === WORKING_KIND}
        <div class="space-y-3">
          {#if hasProject}
            <div class="flex items-center gap-2 rounded-lg border bg-elevated px-1 py-1">
              <button
                type="button"
                class={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${createMode === 'create' ? 'bg-primary text-on-primary' : 'text-muted hover:bg-overlay'}`}
                onclick={() => {
                  createMode = 'create'
                  error = ''
                }}
              >
                New account
              </button>
              <button
                type="button"
                class={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium ${createMode === 'reuse' ? 'bg-primary text-on-primary' : 'text-muted hover:bg-overlay'}`}
                onclick={() => {
                  createMode = 'reuse'
                  error = ''
                }}
              >
                Use existing
              </button>
            </div>
          {/if}

          {#if createMode === 'create'}
            <label class="block space-y-1 text-xs font-medium">
              <span>Account name</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                placeholder="e.g. Coolify — Personal or Coolify — Company"
                autocomplete="off"
                spellcheck="false"
                bind:value={accountLabel}
              />
            </label>
            <label class="block space-y-1 text-xs font-medium">
              <span>Base URL</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm font-mono outline-none focus:border-primary"
                placeholder="https://coolify.internal"
                autocomplete="off"
                spellcheck="false"
                bind:value={baseUrl}
              />
            </label>
            {#if baseUrl.trim() !== '' && !baseUrlValidation.ok}
              <p class="text-[0.6875rem] text-error">{baseUrlValidation.reason}</p>
            {/if}
            <label class="block space-y-1 text-xs font-medium">
              <span>API token</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm font-mono outline-none focus:border-primary"
                type="password"
                placeholder="Coolify API token"
                autocomplete="off"
                spellcheck="false"
                bind:value={token}
              />
            </label>
          {:else}
            {#if existingAccountsForKind.length === 0}
              <p class="rounded-lg border bg-elevated px-3 py-2 text-[0.6875rem] text-muted">
                No {PROVIDER_DISPLAY_NAMES[selectedKind]} accounts exist yet. Create one first.
              </p>
            {:else}
              <label class="block space-y-1 text-xs font-medium">
                <span>Existing {PROVIDER_DISPLAY_NAMES[selectedKind]} account</span>
                <select
                  class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
                  bind:value={selectedExistingAccountId}
                >
                  <option value="">Select an account</option>
                  {#each existingAccountsForKind as account (account.id)}
                    <option value={account.id}>{account.label}</option>
                  {/each}
                </select>
              </label>
            {/if}
          {/if}

          {#if attachedForSelectedKind.length > 0}
            <div class="space-y-1.5">
              <p class="text-[0.6875rem] font-medium text-muted">Attached accounts (active)</p>
              {#each attachedForSelectedKind as accountId (accountId)}
                {@const account = cloudAccountsState.accountById(accountId)}
                {#if account}
                  <div
                    class="flex items-center justify-between gap-2 rounded-lg border bg-elevated px-3 py-1.5"
                  >
                    <span class="min-w-0 truncate text-xs">{account.label}</span>
                    <span class="text-[0.625rem] text-dimmed">
                      {account.id ===
                      config?.project.providerAccounts?.[selectedKind ?? 'coolify']?.activeAccountId
                        ? 'Active'
                        : 'Attached'}
                    </span>
                    {#if account.id !== config?.project.providerAccounts?.[selectedKind ?? 'coolify']?.activeAccountId}
                      <button
                        type="button"
                        class="rounded text-[0.6875rem] font-medium text-primary hover:underline disabled:opacity-50"
                        disabled={saving}
                        onclick={() => void setActive(selectedKind ?? 'coolify', account.id)}
                      >
                        Set active
                      </button>
                    {/if}
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <div class="space-y-4">
      {#if !canAddContainer}
        <div class="space-y-3 rounded-xl border bg-elevated px-4 py-6 text-center">
          <Cloud size={20} class="mx-auto text-dimmed" />
          <p class="text-xs text-muted">
            Attach a provider account first, then add a container to it.
          </p>
          <button
            type="button"
            class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover"
            onclick={() => (mode = 'provider')}
          >
            Add a provider
          </button>
        </div>
      {:else}
        <label class="block space-y-1 text-xs font-medium">
          <span>Provider</span>
          <select
            class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
            bind:value={containerProviderKind}
            onchange={() => void loadAvailableContainers()}
          >
            <option value="">Select a provider</option>
            {#each containerProviders as kind (kind)}
              <option value={kind}>{PROVIDER_DISPLAY_NAMES[kind]}</option>
            {/each}
          </select>
        </label>

        {#if containerProviderKind !== ''}
          {#if availableLoading}
            <div class="flex h-24 items-center justify-center">
              <Loader2 size={17} class="animate-spin text-dimmed" />
            </div>
          {:else if availableError}
            <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
              {availableError}
            </p>
          {:else}
            {#if containerId !== ''}
              <div
                class="flex items-center justify-between gap-2 rounded-lg border bg-elevated px-3 py-2"
              >
                <div class="min-w-0">
                  <p class="truncate text-xs font-medium">{containerLabel || containerId}</p>
                  <p class="truncate font-mono text-[0.625rem] text-dimmed">{containerId}</p>
                </div>
                <button
                  type="button"
                  class="shrink-0 rounded px-2 py-1 text-[0.6875rem] font-medium text-muted hover:bg-overlay hover:text-foreground"
                  onclick={() => {
                    containerId = ''
                    containerLabel = ''
                  }}
                >
                  Change
                </button>
              </div>
            {:else}
              <div class="relative">
                <Search
                  size={13}
                  class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
                />
                <input
                  class="h-9 w-full rounded-lg border bg-elevated pl-8 pr-3 text-sm outline-none focus:border-primary"
                  placeholder="Search your {PROVIDER_DISPLAY_NAMES[
                    containerProviderKind
                  ]} containers"
                  autocomplete="off"
                  spellcheck="false"
                  bind:value={containerSearch}
                />
              </div>
              {#if availableContainers.length === 0}
                <p class="rounded-lg border bg-elevated px-3 py-2 text-[0.6875rem] text-muted">
                  No containers were found on this account. Pick a different provider or add the
                  container manually below.
                </p>
              {:else if filteredAvailable.length === 0}
                <p class="rounded-lg border bg-elevated px-3 py-2 text-[0.6875rem] text-muted">
                  No containers match your search.
                </p>
              {:else}
                <div class="flex items-center justify-between gap-2">
                  <p class="text-[0.6875rem] text-dimmed">
                    {selectedContainerIds.size} selected · click to choose multiple
                  </p>
                  <button
                    type="button"
                    class="rounded px-1.5 py-0.5 text-[0.625rem] font-medium text-primary hover:underline"
                    onclick={() => {
                      if (selectedContainerIds.size === filteredAvailable.length) {
                        selectedContainerIds.clear()
                      } else {
                        for (const container of filteredAvailable) {
                          selectedContainerIds.add(container.id)
                        }
                      }
                    }}
                  >
                    {selectedContainerIds.size === filteredAvailable.length
                      ? 'Clear'
                      : 'Select all'}
                  </button>
                </div>
                <div class="max-h-52 space-y-1 overflow-y-auto pr-0.5">
                  {#each filteredAvailable as container (container.id)}
                    {@const selected = selectedContainerIds.has(container.id)}
                    <button
                      type="button"
                      class="flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors {selected
                        ? 'border-primary bg-raised'
                        : 'hover:bg-overlay'}"
                      aria-pressed={selected}
                      onclick={() => toggleContainer(container)}
                    >
                      <span class="min-w-0">
                        <span class="flex items-center gap-1.5">
                          {#if container.project}
                            <span
                              class="shrink-0 rounded bg-raised px-1 py-0.5 font-mono text-[0.5625rem] text-muted"
                            >
                              {container.project}
                            </span>
                          {/if}
                          <span class="block truncate text-xs font-medium">{container.label}</span>
                        </span>
                        <span class="block truncate font-mono text-[0.625rem] text-dimmed">
                          {container.id}
                        </span>
                      </span>
                      {#if selected}
                        <CheckCircle2 size={14} class="shrink-0 text-primary" />
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            {/if}
          {/if}
        {/if}

        {#if containerProviderKind !== ''}
          <div class="flex items-center gap-2 text-[0.6875rem] text-dimmed">
            <span class="h-px flex-1 bg-border"> </span>
            or enter manually
            <span class="h-px flex-1 bg-border"> </span>
          </div>
        {/if}

        <label class="block space-y-1 text-xs font-medium">
          <span>Container / resource ID</span>
          <input
            class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm font-mono outline-none focus:border-primary"
            placeholder="e.g. the Coolify resource UUID"
            autocomplete="off"
            spellcheck="false"
            bind:value={containerId}
          />
        </label>
        <label class="block space-y-1 text-xs font-medium">
          <span>Label</span>
          <input
            class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
            placeholder="e.g. API server (optional — defaults to the container name)"
            bind:value={containerLabel}
          />
        </label>
      {/if}
    </div>
  {/if}

  {#if error !== ''}
    <p class="mt-4 text-xs text-error">{error}</p>
  {/if}
</SideSheet>
