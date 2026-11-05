import { ipcErrorMessage } from '$lib/ipc-errors'
import { invoke } from '$lib/ipc.svelte'
import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
import { providerStore } from '$lib/stores/providers.svelte'
import type { AcpAgentInput, AcpAgentSettings, AcpAgentStatus, AcpKnownAgent } from '$shared/acp'

/**
 * The ACP agents the user added, over the typed IPC contract.
 *
 * An agent is a name, a command and optional icons: nothing here installs,
 * updates or launches anything. Saving or removing one answers with the whole
 * settings object, so the rail, the editor and the tab counts always read the
 * same list the main process just persisted.
 *
 * The editor's target lives here too. Delete and Edit are started from the rail
 * and from the page header, and both have to reach the one editor panel.
 */
class AcpAgentsStore {
  /** Everything the rail renders; null until the first read lands. */
  settings = $state.raw<AcpAgentSettings | null>(null)
  loading = $state(false)
  saving = $state(false)
  /** Read failure, already phrased for the user. */
  error = $state('')

  /** Which agent the editor is showing, `'new'` while adding one, null when closed. */
  editing = $state<string | 'new' | null>(null)

  /** Whether a read has landed in this window, so a plain `load()` runs once. */
  #loaded = false

  get agents(): AcpAgentStatus[] {
    return this.settings?.agents ?? []
  }

  /** Harnesses known to speak ACP, offered as one-click starting points. */
  get knownAgents(): AcpKnownAgent[] {
    return this.settings?.knownAgents ?? []
  }

  /** The agent the editor is open for; null in the add-agent editor. */
  get editTarget(): AcpAgentStatus | null {
    const id = this.editing
    if (id === null || id === 'new') return null
    return this.get(id) ?? null
  }

  /** Read the agents. A second call is a no-op unless `force` asks again. */
  async load(force = false): Promise<void> {
    if (this.loading || (!force && this.#loaded)) return
    this.loading = true
    this.error = ''
    try {
      this.#replace(await invoke('acpAgents:list'))
    } catch (loadError) {
      this.error = ipcErrorMessage(loadError, 'The ACP agents could not be read.')
    } finally {
      this.loading = false
    }
  }

  /**
   * Save one agent and answer with the refreshed settings.
   *
   * The failure is rethrown rather than swallowed: the editor shows it inline
   * under the form, where the field that caused it is.
   */
  async save(input: AcpAgentInput): Promise<AcpAgentSettings> {
    this.saving = true
    const before = new Set(this.settings?.agents.map((agent) => agent.id) ?? [])
    try {
      const next = await invoke('acpAgents:save', input)
      this.#replace(next)
      await this.#refreshHarness(input.id ?? this.editing)
      // Creating an agent pins the editor to the record it just made, so saving
      // again edits that agent instead of adding another copy of it.
      if (input.id === undefined) {
        const created = next.agents.find((agent) => !before.has(agent.id))
        if (created) this.editing = created.id
      }
      return next
    } finally {
      this.saving = false
    }
  }

  /** Forget one agent. Removing an agent never touches anything it installed. */
  async remove(id: string): Promise<AcpAgentSettings> {
    this.saving = true
    try {
      const next = await invoke('acpAgents:remove', id)
      this.#replace(next)
      // A removed agent's models are not a stale cache, they are gone.
      providerCatalog.invalidateAll()
      return next
    } finally {
      this.saving = false
    }
  }

  get(id: string): AcpAgentStatus | undefined {
    return this.settings?.agents.find((agent) => agent.id === id)
  }

  /** Display name for an `acp-` harness id, for transcript attribution. */
  nameFor(id: string): string | undefined {
    return this.get(id)?.name
  }

  openNew(): void {
    this.editing = 'new'
  }

  openEdit(id: string): void {
    this.editing = id
  }

  closeEditor(): void {
    this.editing = null
  }

  /**
   * Drop the cached harness rows and model catalog for one agent.
   *
   * A new agent is a harness the picker has never discovered, and a sign-in let
   * an existing one report models it previously refused. Both cases are stale
   * answers in the renderer's caches, so neither can wait for a TTL sweep.
   */
  async #refreshHarness(id: string | 'new' | null | undefined): Promise<void> {
    providerCatalog.invalidateAll()
    if (typeof id !== 'string') return
    await providerStore.checkOne(id).catch(() => undefined)
  }

  #replace(next: AcpAgentSettings): void {
    this.settings = next
    this.#loaded = true
    this.error = ''
  }
}

export const acpAgentsStore = new AcpAgentsStore()
