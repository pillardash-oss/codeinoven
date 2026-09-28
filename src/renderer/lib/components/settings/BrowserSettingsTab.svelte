<script lang="ts">
  import { Plus, X } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import {
    DEFAULT_BROWSER_SEARCH_ENGINE_ID,
    MAX_BROWSER_CUSTOM_SEARCH_ENGINES,
    browserSearchEngines,
    normalizeBrowserSearchUrlTemplate,
    type BrowserSearchEngine
  } from '$shared/browser-search-engines'
  import {
    MAX_BROWSER_HIBERNATION_MINUTES,
    MIN_BROWSER_HIBERNATION_MINUTES,
    type AppConfig,
    type AppConfigPatch
  } from '$shared/types'
  import { uuidv7 } from '$shared/id'
  import Switch from '../ui/Switch.svelte'
  import PrototypeCdnSettings from './PrototypeCdnSettings.svelte'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  const engines = $derived(browserSearchEngines(config.browserCustomSearchEngines ?? []))
  const customEngines = $derived(config.browserCustomSearchEngines ?? [])
  const atEngineCapacity = $derived(customEngines.length >= MAX_BROWSER_CUSTOM_SEARCH_ENGINES)

  /** The engine being defined. Cleared once it lands in the config. */
  let engineName = $state('')
  let engineTemplate = $state('')

  const pendingTemplate = $derived(normalizeBrowserSearchUrlTemplate(engineTemplate))
  const pendingName = $derived(engineName.trim())
  const duplicateName = $derived(
    pendingName !== '' && customEngines.some((engine) => engine.name === pendingName)
  )
  const canAddEngine = $derived(
    pendingName !== '' && pendingTemplate !== null && !duplicateName && !atEngineCapacity
  )

  function selectEngine(id: string): void {
    void updateConfig({ browserSearchEngine: id })
  }

  function addEngine(): void {
    const name = engineName.trim()
    if (name === '') {
      toast.error('Give the search engine a name.')
      return
    }
    if (duplicateName) {
      toast.error('A search engine with that name already exists.')
      return
    }
    const template = normalizeBrowserSearchUrlTemplate(engineTemplate)
    if (!template) {
      toast.error('Enter an http or https URL, using %s for the query.')
      return
    }
    if (atEngineCapacity) {
      toast.error(`At most ${MAX_BROWSER_CUSTOM_SEARCH_ENGINES} custom search engines are allowed.`)
      return
    }
    const engine: BrowserSearchEngine = { id: uuidv7(), name, searchUrlTemplate: template }
    engineName = ''
    engineTemplate = ''
    void updateConfig({ browserCustomSearchEngines: [...customEngines, engine] })
  }

  function removeEngine(id: string): void {
    const remaining = customEngines.filter((engine) => engine.id !== id)
    // Removing the engine the default points at would leave a dangling id, so
    // the default is moved to the shipped engine in the same write.
    const patch: AppConfigPatch = { browserCustomSearchEngines: remaining }
    if (config.browserSearchEngine === id) {
      patch.browserSearchEngine = DEFAULT_BROWSER_SEARCH_ENGINE_ID
    }
    void updateConfig(patch)
  }

  function submitEngine(event: SubmitEvent): void {
    event.preventDefault()
    addEngine()
  }

  function saveHibernationMinutes(event: Event): void {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return

    const value = Number(input.value)
    if (
      !Number.isInteger(value) ||
      value < MIN_BROWSER_HIBERNATION_MINUTES ||
      value > MAX_BROWSER_HIBERNATION_MINUTES
    ) {
      input.value = String(config.browserHibernationMinutes)
      return
    }

    void updateConfig({ browserHibernationMinutes: value })
  }
</script>

<div class="p-6 pb-24">
  <div class="mb-6">
    <h1 class="text-xl font-bold tracking-tight">Browser</h1>
    <p class="mt-0.5 text-sm text-muted">
      How links are routed, what typed text searches for, and how tabs behave.
    </p>
  </div>

  <div class="space-y-4">
    <!-- Link routing -->
    <div id="settings-block-browser-links" class="rounded-xl border bg-surface p-4">
      <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Links</h3>
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">Open localhost on CIO's browser</p>
          <p class="text-xs leading-relaxed text-dimmed">
            Keep local development links inside the workspace for testing
          </p>
        </div>
        <Switch
          checked={config.openLocalhostInCioBrowser}
          onchange={() =>
            void updateConfig({ openLocalhostInCioBrowser: !config.openLocalhostInCioBrowser })}
          aria-label="Toggle opening localhost links in CIO's browser"
          disabled={!settingsReady}
        />
      </div>
      <div class="mt-4 border-t pt-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium">Open all other links on CIO's browser</p>
            <p class="text-xs leading-relaxed text-dimmed">
              Send every non-local link to the workspace browser of the current project or thread
              instead of your default browser
            </p>
          </div>
          <Switch
            checked={config.openAllLinksInCioBrowser}
            onchange={() =>
              void updateConfig({ openAllLinksInCioBrowser: !config.openAllLinksInCioBrowser })}
            aria-label="Toggle opening all other links in CIO's browser"
            disabled={!settingsReady}
          />
        </div>
      </div>
    </div>

    <!-- Search engine -->
    <div id="settings-block-browser-search" class="rounded-xl border bg-surface p-4">
      <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Search</h3>
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">Search engine</p>
          <p class="text-xs leading-relaxed text-dimmed">
            Text that is not an address is searched with this engine
          </p>
        </div>
        <select
          class="max-w-[14rem] rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-medium outline-none focus:border-primary disabled:opacity-50"
          value={config.browserSearchEngine}
          disabled={!settingsReady}
          aria-label="Default search engine"
          onchange={(event) => selectEngine(event.currentTarget.value)}
        >
          {#each engines as engine (engine.id)}
            <option value={engine.id}>{engine.name}</option>
          {/each}
        </select>
      </div>

      <div class="mt-4 border-t pt-4">
        {#if customEngines.length > 0}
          <ul class="mb-3 space-y-2">
            {#each customEngines as engine (engine.id)}
              <li
                class="flex items-center justify-between gap-3 rounded-lg border bg-elevated px-3 py-2"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">{engine.name}</p>
                  <p class="truncate font-mono text-xs text-dimmed">{engine.searchUrlTemplate}</p>
                </div>
                <button
                  type="button"
                  class="shrink-0 rounded p-1 text-muted hover:bg-overlay hover:text-foreground disabled:opacity-50"
                  title={`Remove the ${engine.name} search engine`}
                  aria-label={`Remove the ${engine.name} search engine`}
                  disabled={!settingsReady}
                  onclick={() => removeEngine(engine.id)}
                >
                  <X size={13} />
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        <form class="space-y-2" onsubmit={submitEngine}>
          <div class="flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              class="h-9 min-w-0 flex-1 rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary disabled:opacity-50"
              placeholder="Engine name"
              aria-label="Custom search engine name"
              bind:value={engineName}
              disabled={!settingsReady || atEngineCapacity}
            />
            <input
              type="text"
              class="h-9 min-w-0 flex-1 rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary disabled:opacity-50"
              placeholder="https://example.com/search?q=%s"
              aria-label="Custom search engine URL, using %s for the query"
              spellcheck="false"
              autocomplete="off"
              bind:value={engineTemplate}
              disabled={!settingsReady || atEngineCapacity}
            />
            <button
              type="submit"
              class="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium outline-none hover:bg-overlay focus:border-primary disabled:opacity-50"
              title="Add this search engine"
              aria-label="Add this search engine"
              disabled={!settingsReady || !canAddEngine}
            >
              <Plus size={13} />
              Add
            </button>
          </div>
          <p class="text-xs leading-relaxed text-dimmed">
            Put <span class="font-mono">%s</span> where the query goes. Without it the query is
            appended as <span class="font-mono">?q=</span>.
          </p>
        </form>
      </div>
    </div>

    <!-- Tabs -->
    <div id="settings-block-browser-tabs" class="rounded-xl border bg-surface p-4">
      <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Tabs</h3>
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">Hibernate inactive tabs</p>
          <p class="text-xs leading-relaxed text-dimmed">
            Free the memory of a browser tab that has not been used for this long; it reloads when
            you come back to it
          </p>
        </div>
        <label class="flex shrink-0 items-center gap-2 text-xs text-muted">
          <input
            class="w-20 rounded-lg border bg-elevated px-2.5 py-1 text-right text-sm font-medium tabular-nums outline-none focus:border-primary disabled:opacity-50"
            type="number"
            min={MIN_BROWSER_HIBERNATION_MINUTES}
            max={MAX_BROWSER_HIBERNATION_MINUTES}
            step="1"
            value={config.browserHibernationMinutes}
            disabled={!settingsReady}
            aria-label="Minutes before an inactive browser tab hibernates"
            onchange={saveHibernationMinutes}
          />
          minutes
        </label>
      </div>
    </div>

    <!-- Prototype previews -->
    <PrototypeCdnSettings {config} {settingsReady} {updateConfig} />
  </div>
</div>
