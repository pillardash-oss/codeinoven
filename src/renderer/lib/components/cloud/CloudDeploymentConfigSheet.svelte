<script lang="ts">
  import { CheckCircle2, Cloud, Loader2 } from '@lucide/svelte'
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
    projectId: string
    onClose: () => void
    /** Provider kinds already configured for this project, scoping container choices. */
    configuredProviders?: CloudDeploymentProviderKind[]
    /** The flow the sheet opens in. */
    initialMode?: Mode
    /** Called after a successful save so the caller can refresh its view. */
    onSaved?: () => void
  }

  let {
    open,
    projectId,
    onClose,
    configuredProviders = [],
    initialMode = 'provider',
    onSaved
  }: Props = $props()

  type Mode = 'provider' | 'container'

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
  let saving = $state(false)
  let error = $state('')
  /** The project's current config, loaded on open. */
  let config = $state<CloudDeploymentConfig | null>(null)

  let canAddContainer = $derived(configuredProviders.length > 0)

  let containerProviders = $derived(
    PROVIDER_KINDS.filter((kind) => configuredProviders.includes(kind))
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
      : containerProviderKind !== '' && containerId.trim() !== '' && containerLabel.trim() !== ''
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
    containerProviderKind = ''
    containerId = ''
    containerLabel = ''
    config = null
    error = ''
    saving = false
  }

  $effect(() => {
    if (!open) return
    resetSheet()
    void cloudAccountsState.load()
    void invoke('cloudDeploy:getConfig', projectId)
      .then((loaded) => {
        config = loaded
      })
      .catch(() => undefined)
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
    error = ''
  }

  /** Set which attached account is active for a provider within the project. */
  async function setActive(kind: CloudDeploymentProviderKind, accountId: string): Promise<void> {
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
        // Create the global account (token vaulted by account id), then attach.
        const account = await cloudAccountsState.createAccount(
          selectedKind,
          accountLabel.trim(),
          token.trim(),
          validation.baseUrl ?? undefined
        )
        config = await cloudAccountsState.attachAccount(projectId, selectedKind, account.id)
        toast.success(`Created and attached “${account.label}”.`)
      } else {
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

  async function saveContainer(): Promise<void> {
    if (containerProviderKind === '') return
    const id = containerId.trim()
    const label = containerLabel.trim()
    if (id === '') {
      error = 'Enter the container or resource ID.'
      return
    }
    if (label === '') {
      error = 'Enter a label for the container.'
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
      const alreadyConfigured = current.project.containers.some(
        (mapping) => mapping.providerKind === containerProviderKind && mapping.id === id
      )
      if (alreadyConfigured) {
        error = 'A container with this provider and ID is already configured.'
        return
      }
      const now = Date.now()
      const container: CloudDeploymentContainer = {
        id,
        label,
        providerKind: containerProviderKind,
        status: 'unknown',
        createdAt: now,
        updatedAt: now
      }
      const updated: CloudDeploymentConfig = {
        ...current,
        project: { ...current.project, containers: [...current.project.containers, container] },
        updatedAt: now
      }
      config = await invoke('cloudDeploy:saveConfig', projectId, updated)
      toast.success(`Added container “${label}”.`)
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
      <p class="min-w-0 flex-1 truncate text-[11px] text-dimmed">
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
          {mode === 'provider' ? 'Save provider' : 'Add container'}
        </button>
      </div>
    </div>
  {/snippet}

  <div
    class="mb-4 flex items-center justify-between gap-3 rounded-lg border bg-elevated px-3 py-2.5"
  >
    <div class="min-w-0">
      <p class="text-xs font-medium">{mode === 'provider' ? 'Add provider' : 'Add container'}</p>
      <p class="text-[11px] text-muted">
        {mode === 'provider'
          ? 'Create a reusable account or attach an existing one.'
          : 'Attach a container to a configured provider.'}
      </p>
    </div>
    <Switch
      checked={mode === 'container'}
      onchange={(v) => {
        mode = v ? 'container' : 'provider'
        error = ''
      }}
      aria-label="Toggle between adding a provider and adding a container"
    />
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
                <span class="block text-[11px] text-muted">
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
              <p class="text-[11px] text-error">{baseUrlValidation.reason}</p>
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
              <p class="rounded-lg border bg-elevated px-3 py-2 text-[11px] text-muted">
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
              <p class="text-[11px] font-medium text-muted">Attached accounts (active)</p>
              {#each attachedForSelectedKind as accountId (accountId)}
                {@const account = cloudAccountsState.accountById(accountId)}
                {#if account}
                  <div
                    class="flex items-center justify-between gap-2 rounded-lg border bg-elevated px-3 py-1.5"
                  >
                    <span class="min-w-0 truncate text-xs">{account.label}</span>
                    <span class="text-[10px] text-dimmed">
                      {account.id ===
                      config?.project.providerAccounts?.[selectedKind ?? 'coolify']?.activeAccountId
                        ? 'Active'
                        : 'Attached'}
                    </span>
                    {#if account.id !== config?.project.providerAccounts?.[selectedKind ?? 'coolify']?.activeAccountId}
                      <button
                        type="button"
                        class="rounded text-[11px] font-medium text-primary hover:underline disabled:opacity-50"
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
          >
            <option value="">Select a provider</option>
            {#each containerProviders as kind (kind)}
              <option value={kind}>{PROVIDER_DISPLAY_NAMES[kind]}</option>
            {/each}
          </select>
        </label>
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
            placeholder="e.g. API server"
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
