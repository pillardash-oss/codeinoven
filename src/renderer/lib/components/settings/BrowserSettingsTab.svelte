<script lang="ts">
  import { onMount } from 'svelte'
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
    MAX_BROWSER_HISTORY_LIMIT,
    MIN_BROWSER_HIBERNATION_MINUTES,
    MIN_BROWSER_HISTORY_LIMIT,
    type AppConfig,
    type AppConfigPatch
  } from '$shared/types'
  import { uuidv7 } from '$shared/id'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import { browserHistory } from '$lib/stores/browser-history.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
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

  /** Which library the user asked to empty, held while the confirmation is up.
   *  Both clears are destructive and irreversible, so each one is confirmed. */
  let clearing = $state<'history' | 'bookmarks' | null>(null)

  /** Live sizes, so the two buttons say what is actually at stake before the user
   *  commits to a clear. */
  const historyCount = $derived(browserHistory.count)
  const bookmarkCount = $derived(browserBookmarks.count)

  // The two stores read their file when the browser's runtime comes up, and this
  // page can be the first thing a session opens. Asking here is what makes the
  // counts, and the clear buttons they gate, describe the stored library rather
  // than an empty one this page happened to look at first.
  onMount(() => {
    browserHistory.start()
    browserBookmarks.start()
  })

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

  function saveHistoryLimit(event: Event): void {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return

    const value = Number(input.value)
    if (
      !Number.isInteger(value) ||
      value < MIN_BROWSER_HISTORY_LIMIT ||
      value > MAX_BROWSER_HISTORY_LIMIT
    ) {
      input.value = String(config.browserHistoryLimit)
      return
    }

    void updateConfig({ browserHistoryLimit: value }).then(() => {
      // A smaller cap evicts the oldest visits at once, so the list on screen
      // agrees with the setting the user just saved rather than waiting for the
      // next visit to trim it.
      browserHistory.applyLimit()
    })
  }

  /** Empty one of the two libraries, which is applied in main as well so a write
   *  still in flight cannot put back what was cleared. */
  async function confirmClear(): Promise<void> {
    const target = clearing
    clearing = null
    if (target === 'history') {
      await browserHistory.clear()
      toast.success('Browsing history cleared.')
      return
    }
    if (target === 'bookmarks') {
      await browserBookmarks.clear()
      toast.success('Bookmarks cleared.')
    }
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

    <!-- Browsing data -->
    <div id="settings-block-browser-library" class="rounded-xl border bg-surface p-4">
      <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Browsing data</h3>
      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-sm font-medium">History size</p>
          <p class="text-xs leading-relaxed text-dimmed">
            How many pages the browser remembers. Older visits are dropped once the limit is
            reached, so the newest ones are always kept.
          </p>
        </div>
        <label class="flex shrink-0 items-center gap-2 text-xs text-muted">
          <input
            class="w-20 rounded-lg border bg-elevated px-2.5 py-1 text-right text-sm font-medium tabular-nums outline-none focus:border-primary disabled:opacity-50"
            type="number"
            min={MIN_BROWSER_HISTORY_LIMIT}
            max={MAX_BROWSER_HISTORY_LIMIT}
            step="1"
            value={config.browserHistoryLimit}
            disabled={!settingsReady}
            aria-label="How many pages the browsing history keeps"
            onchange={saveHistoryLimit}
          />
          pages
        </label>
      </div>

      <div class="mt-4 space-y-3 border-t pt-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium">Clear browsing history</p>
            <p class="text-xs leading-relaxed text-dimmed">
              Forget every page you have visited. Your bookmarks are kept.
            </p>
          </div>
          <button
            type="button"
            class="flex h-8 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs font-semibold text-danger hover:bg-danger/10 disabled:opacity-50"
            disabled={!settingsReady || historyCount === 0}
            title="Clear every page from your browsing history"
            aria-label="Clear browsing history"
            onclick={() => (clearing = 'history')}
          >
            Clear
            {#if historyCount > 0}<span class="tabular-nums">{historyCount}</span>{/if}
          </button>
        </div>

        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium">Clear bookmarks</p>
            <p class="text-xs leading-relaxed text-dimmed">
              Remove every saved page. Your browsing history is kept.
            </p>
          </div>
          <button
            type="button"
            class="flex h-8 shrink-0 items-center gap-2 rounded-lg border px-3 text-xs font-semibold text-danger hover:bg-danger/10 disabled:opacity-50"
            disabled={!settingsReady || bookmarkCount === 0}
            title="Remove every saved page"
            aria-label="Clear bookmarks"
            onclick={() => (clearing = 'bookmarks')}
          >
            Clear
            {#if bookmarkCount > 0}<span class="tabular-nums">{bookmarkCount}</span>{/if}
          </button>
        </div>
      </div>
    </div>

    <!-- Prototype previews -->
    <PrototypeCdnSettings {config} {settingsReady} {updateConfig} />
  </div>
</div>

<ConfirmDialog
  open={clearing !== null}
  title={clearing === 'bookmarks' ? 'Clear all bookmarks?' : 'Clear your browsing history?'}
  confirmLabel={clearing === 'bookmarks' ? 'Clear bookmarks' : 'Clear history'}
  variant="danger"
  onConfirm={confirmClear}
  onCancel={() => (clearing = null)}
>
  {#if clearing === 'bookmarks'}
    <p>
      Every saved page is removed. This cannot be undone. Your browsing history is not affected.
    </p>
  {:else}
    <p>
      Every page you have visited is forgotten. This cannot be undone. Your bookmarks are not
      affected.
    </p>
  {/if}
</ConfirmDialog>
