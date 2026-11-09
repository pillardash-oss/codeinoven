<script lang="ts">
  import CardNotice from '../shared/CardNotice.svelte'
  import SettingsStatusBadge from '../shared/SettingsStatusBadge.svelte'
  import CioCircle from '@pdslng/cio-icon/CioCircle.svelte'
  import { ipcErrorMessage } from '$lib/ipc-errors'
  import type { IdeInstallation } from '$shared/editor-ide'
  import {
    rememberIdeResults,
    recalledIdeResults,
    forgetIdeResults
  } from '$lib/editor/ide-floating-results'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'
  import { navigateTo } from '$lib/app-control/app-control-actions'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import DeferredMarkdownView from '$lib/components/markdown/DeferredMarkdownView.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import type { AppPanelPortal } from '$lib/app-panel-portal'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { invoke, subscribeGuarded } from '$lib/ipc.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import type {
    IdeAction,
    IdeCodeAction,
    IdeCompletionItem,
    IdeLocation,
    IdeProgress,
    IdeResponse
  } from '$shared/editor-ide'
  import type { IdeToken, IdeMenuAction } from '$lib/editor/ide-context'
  import { toast } from 'svelte-sonner'

  interface Props {
    projectId: string
    scopeBucketId?: string
    threadId?: string
    path: string
    value: string
    enabled?: boolean
    projectName?: string
    statusPortal?: AppPanelPortal
    /** Write a whole-document text the language server produced, such as an
     *  applied import or quick fix. The editor owns its own buffer. */
    onReplaceDocument?: (text: string) => void
  }
  let {
    projectId,
    scopeBucketId,
    threadId,
    path,
    value,
    enabled = false,
    projectName = '',
    statusPortal,
    onReplaceDocument
  }: Props = $props()
  let resolvedProjectName = $state('')
  let connectedServers = $state<IdeResponse['servers']>([])
  let installations = $state<IdeInstallation[]>([])
  let infoChecking = $state(false)
  let infoOpen = $state(false)
  let floatingRoot: HTMLDivElement | undefined
  let anchor = $state({ x: 16, y: 80 })
  let hoverLeaveTimer: ReturnType<typeof setTimeout> | undefined
  const owner = crypto.randomUUID()
  let capabilities = $state<IdeResponse['capabilities']>()
  let open = $state(false)
  let mode = $state<'grep' | 'files' | 'locations' | 'documentation'>('locations')
  let query = $state('')
  let selectedIndex = $state(0)
  let resultList: HTMLDivElement | undefined
  let results = $state.raw<IdeLocation[]>([])
  let documentation = $state('')
  let error = $state('')
  let busy = $state(false)
  let failedRetry = -1
  let serverError = $state('')
  let connecting = $state(false)
  let retryVersion = $state(0)
  let locationTitle = $state('Code locations')
  let truncated = $state(false)
  /**
   * Whether the project text search matches case.
   *
   * Off by default: a reader searching a project is looking for the text, not
   * for its capitalisation, so an exact-case scan is the deliberate choice they
   * turn on in the modal's footer. It outlives one search, because a reader who
   * wants exact case wants it for the next query too.
   */
  let caseSensitive = $state(false)
  let hover = $state<{ text: string; x: number; y: number } | null>(null)
  /**
   * What the language servers themselves report doing, keyed by server and work
   * item. A server announces project loading as work-done progress, so this is
   * the only honest source for an "indexing" percentage.
   */
  let progress = $state.raw<Record<string, IdeProgress>>({})
  let progressEntries = $state.raw<IdeProgress[]>([])
  let sequence = 0
  let alive = false
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchStarted = false
  const floatingKey = $derived(`${projectId}:${scopeBucketId ?? ''}:${threadId ?? ''}`)
  const active = $derived(enabled && Boolean(projectId))

  /**
   * Which requests read the document itself.
   *
   * Only these carry the buffer. A project text search, a file lookup and every
   * lifecycle request answer without it, so shipping the file body for them was
   * a wasted multi-megabyte structured clone over IPC on every search keystroke,
   * and a hard failure once the open file crossed the request's 2 MB limit. The
   * editor already holds the same string as `value`, so nothing is lost for the
   * requests that do need it.
   */
  const DOCUMENT_ACTIONS: ReadonlySet<IdeAction> = new Set<IdeAction>([
    'sync',
    'definition',
    'references',
    'hover',
    'format',
    'completion',
    // Resolve reads the buffer too: the server's project copy must match what
    // the reader sees, or the import edit would be computed against the saved
    // file instead of the line being typed on.
    'resolveCompletion',
    'codeActions',
    'applyCodeAction'
  ])

  /** The largest body the IDE channel accepts; the main process refuses more. */
  const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024

  async function request(
    action: IdeAction,
    token?: IdeToken,
    text?: string,
    extra?: { triggerKind?: number; triggerCharacter?: string; payload?: unknown }
  ): Promise<IdeResponse> {
    const body = text ?? (DOCUMENT_ACTIONS.has(action) ? value : undefined)
    return invoke(
      'projectFiles:ide',
      projectId,
      {
        owner,
        action,
        path,
        // A file past the channel's body limit is never sent: the worker reads
        // it from disk, which is slower but answers, where a refused request
        // left IDE Mode unusable for that file.
        text: body !== undefined && body.length > MAX_DOCUMENT_BYTES ? undefined : body,
        line: token?.line,
        character: token?.character,
        query,
        caseSensitive: action === 'grep' ? caseSensitive : undefined,
        triggerKind: extra?.triggerKind,
        triggerCharacter: extra?.triggerCharacter,
        payload: extra?.payload
      },
      scopeBucketId,
      threadId
    )
  }

  /**
   * Re-lay-out a document through the file's own language server.
   *
   * Returns `null` when nothing came back: IDE Mode is off, no server covering
   * this file advertises formatting, the server answered with no edits, or the
   * request failed. A failed format must never cost the user their save, so the
   * caller keeps the text it already had.
   */
  export async function formatText(text: string): Promise<string | null> {
    if (!active) return null
    try {
      const result = await request('format', undefined, text)
      return result.text && result.text !== text ? result.text : null
    } catch {
      return null
    }
  }

  interface SessionContext {
    projectId: string
    scopeBucketId?: string
    threadId?: string
    path: string
  }

  // Attachments own the external session and its document stream separately.
  function connect(enabled: boolean, context: SessionContext): (() => void) | undefined {
    if (!enabled) return
    alive = true
    const recalled = recalledIdeResults(floatingKey)
    if (recalled) {
      results = recalled.results
      selectedIndex = recalled.selectedIndex
      locationTitle = recalled.title
      anchor = recalled.anchor
      mode = 'locations'
      open = true
    }
    if (!projectName)
      void invoke('project:get', context.projectId)
        .then((project) => {
          if (alive) resolvedProjectName = project?.name ?? context.projectId
        })
        .catch(() => {
          resolvedProjectName = context.projectId
        })
    serverError = ''
    // One window may hold several editors; the subscription is per editor so the
    // panel only ever shows progress while the file it belongs to is on screen.
    const stopProgress = subscribeGuarded('projectFiles:ideProgress', (entry) => {
      const key = `${entry.serverId}:${entry.token}`
      const next = { ...progress }
      if (entry.kind === 'end') delete next[key]
      else next[key] = entry
      progress = next
      progressEntries = Object.values(next).sort(
        (left, right) =>
          left.serverId.localeCompare(right.serverId) ||
          (left.title ?? '').localeCompare(right.title ?? '')
      )
    })
    failedRetry = -1
    return () => {
      alive = false
      infoOpen = false
      stopProgress()
      progress = {}
      progressEntries = []
      connectedServers = undefined
      clearTimeout(hoverLeaveTimer)
      capabilities = undefined
      hover = null
      closeModal(true)
      void invoke(
        'projectFiles:ide',
        context.projectId,
        { owner, action: 'close', path: context.path },
        context.scopeBucketId,
        context.threadId
      ).catch(() => undefined)
    }
  }

  function syncDocument(
    enabled: boolean,
    context: SessionContext,
    text: string,
    retry: number
  ): (() => void) | undefined {
    if (!enabled || failedRetry === retry) return
    sequence++
    busy = false
    hover = null
    let cancelled = false
    const timer = setTimeout(() => {
      connecting = !capabilities
      serverError = ''
      void invoke(
        'projectFiles:ide',
        context.projectId,
        { owner, action: 'sync', path: context.path, text },
        context.scopeBucketId,
        context.threadId
      )
        .then((result) => {
          if (!cancelled && alive) {
            installations = result.installations ?? []
            connectedServers = result.servers ?? []
            capabilities = result.capabilities
            failedRetry = -1
            connecting = false
          }
        })
        .catch((reason: unknown) => {
          if (!cancelled && alive) {
            connecting = false
            capabilities = undefined
            failedRetry = retry
            serverError = ipcErrorMessage(reason, 'Language server unavailable')
          }
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }

  /**
   * Drop the pending debounce and the marker of a search still running.
   *
   * Replacing a query needs no cancel round trip: the next `grep` kills the
   * previous ripgrep process inside the editor worker. Sending a cancel per
   * keystroke put two main-process round trips behind every character typed.
   */
  function cancelSearch(): void {
    clearTimeout(searchTimer)
    searchStarted = false
  }

  /** Stop a search that is already running; the modal closing and an emptied
   *  search box both need it, a replaced query does not. */
  function stopRunningSearch(): void {
    if (!searchStarted) return
    cancelSearch()
    void invoke('projectFiles:ide', projectId, { owner, action: 'cancel', path: '' }).catch(
      () => undefined
    )
  }

  function closeModal(preserve = false): void {
    if (!preserve) forgetIdeResults(floatingKey)
    sequence++
    open = false
    busy = false
    stopRunningSearch()
  }

  export function dismissHover(): void {
    clearTimeout(hoverLeaveTimer)
    hoverLeaveTimer = setTimeout(() => {
      hover = null
      if (!busy && !open) sequence++
    }, 400)
  }
  function keepHover(): void {
    clearTimeout(hoverLeaveTimer)
  }
  function dismissOutside(event: PointerEvent): void {
    if (event.target instanceof Node && floatingRoot?.contains(event.target)) return
    hover = null
    if (open && mode !== 'grep' && mode !== 'files') closeModal()
  }
  function positionFloating(node: HTMLDivElement): () => void {
    floatingRoot = node
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    node.showPopover()
    if (!hover) node.focus({ preventScroll: true })
    const unregister = registerOverlayClose(() => {
      hover = null
      closeModal()
    }, false)
    const position = () => {
      const rect = node.getBoundingClientRect()
      node.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - rect.width - 8))}px`
      node.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - rect.height - 8))}px`
    }
    const observer = new ResizeObserver(position)
    observer.observe(node)
    position()
    return () => {
      if (node.contains(document.activeElement) && previousFocus?.isConnected)
        previousFocus.focus({ preventScroll: true })
      unregister()
      observer.disconnect()
      floatingRoot = undefined
    }
  }
  /**
   * The completion list for the caret, one request at a time.
   *
   * Typing is faster than a language server answers, so only the newest ask is
   * kept: every earlier one resolves empty and its answer is never shown. That
   * also keeps the IDE channel from filling with stale keystrokes.
   */
  interface CompletionQuery {
    line: number
    character: number
    triggerKind?: number
    triggerCharacter?: string
  }
  let pendingCompletion: {
    query: CompletionQuery
    resolve: (items: IdeCompletionItem[]) => void
  } | null = null
  let completionRunning = false
  export function completions(query: CompletionQuery): Promise<IdeCompletionItem[]> {
    if (!active) return Promise.resolve([])
    return new Promise((resolve) => {
      pendingCompletion?.resolve([])
      pendingCompletion = { query, resolve }
      if (!completionRunning) void drainCompletions()
    })
  }
  async function drainCompletions(): Promise<void> {
    completionRunning = true
    try {
      for (;;) {
        const next = pendingCompletion
        if (!next) break
        pendingCompletion = null
        try {
          const result = await request(
            'completion',
            { line: next.query.line, character: next.query.character, word: '', x: 0, y: 0 },
            undefined,
            {
              triggerKind: next.query.triggerKind,
              triggerCharacter: next.query.triggerCharacter
            }
          )
          capabilities = result.capabilities ?? capabilities
          next.resolve(result.completions ?? [])
        } catch {
          next.resolve([])
        }
      }
    } finally {
      completionRunning = false
    }
  }
  /** Resolve one accepted completion, which is where tsserver puts the import. */
  export async function resolveCompletion(
    item: IdeCompletionItem
  ): Promise<IdeCompletionItem | null> {
    if (!active) return null
    try {
      const result = await request(
        'resolveCompletion',
        { line: 0, character: 0, word: '', x: 0, y: 0 },
        undefined,
        { payload: item }
      )
      return result.completions?.[0] ?? null
    } catch {
      return null
    }
  }
  /**
   * The context menu, with the file's own code actions on top.
   *
   * Imports and quick fixes are not a separate section: they are actions of the
   * same kind as Go to Definition, so they sit beside it whenever the language
   * server has one for the code under the cursor.
   */
  export async function actions(token: IdeToken): Promise<IdeMenuAction[]> {
    if (!active) return []
    const items: IdeMenuAction[] = []
    if (!capabilities || capabilities.definition)
      items.push({ label: 'Go to Definition', run: () => handle('definition', token) })
    if (!capabilities || capabilities.references)
      items.push({ label: 'Find References', run: () => handle('references', token) })
    if (!capabilities || capabilities.hover)
      items.push({ label: 'Show Documentation', run: () => handle('documentation', token) })
    const codeActions = await loadCodeActions(token)
    for (const action of codeActions) {
      if (action.disabled) continue
      items.unshift({ label: action.title, run: () => void applyCodeAction(action) })
    }
    items.push(
      {
        label: `Search ${projectName || resolvedProjectName} text`,
        run: () => handle('grep', token)
      },
      {
        label: `Find file in ${projectName || resolvedProjectName}`,
        run: () => handle('files', token)
      }
    )
    return items
  }
  async function loadCodeActions(token: IdeToken): Promise<IdeCodeAction[]> {
    if (!capabilities?.codeActions && capabilities) return []
    try {
      const result = await request('codeActions', token)
      return result.codeActions ?? []
    } catch {
      // A menu must still open when the server cannot answer quickly.
      return []
    }
  }
  async function applyCodeAction(action: IdeCodeAction): Promise<void> {
    try {
      const result = await request('applyCodeAction', undefined, value, { payload: action })
      if (!result.text || result.text === value) return
      if (!onReplaceDocument) {
        toast.error('The editor closed before the action could be applied')
        return
      }
      onReplaceDocument(result.text)
      const skipped = result.skippedFiles?.length ?? 0
      if (skipped)
        toast.info(
          `${action.title} also changes ${skipped} other file${skipped === 1 ? '' : 's'}; only this file was updated.`
        )
    } catch (reason) {
      toast.error(ipcErrorMessage(reason, 'The code action could not be applied'))
    }
  }
  /**
   * Open one of the two project searches without a token under the cursor.
   *
   * The viewer menu asks for exactly the search a right-click on a word offers,
   * but it has no word to seed the query with, so it starts empty and the
   * modal's own input takes the focus.
   */
  export function searchProjectText(seed = ''): boolean {
    return openSearch('grep', seed)
  }
  export function findProjectFile(seed = ''): boolean {
    return openSearch('files', seed)
  }
  function openSearch(
    next: 'grep' | 'files',
    seed: string,
    at: { x: number; y: number } = { x: 16, y: 80 }
  ): boolean {
    if (!active) return false
    clearTimeout(hoverLeaveTimer)
    anchor = at
    mode = next
    query = seed
    selectedIndex = 0
    results = []
    truncated = false
    hover = null
    open = true
    error = ''
    // The modal and its loading row are on screen before any work starts: the
    // search is scheduled on the next task, never inside this one.
    scheduleSearch(true)
    return true
  }

  export function handle(
    action: 'definition' | 'references' | 'documentation' | 'hover' | 'grep' | 'files',
    token: IdeToken
  ): boolean {
    if (!active) return false
    if (action !== 'hover') {
      clearTimeout(hoverLeaveTimer)
      anchor = { x: token.x || 16, y: (token.y || 64) + 12 }
    }
    if (action === 'grep' || action === 'files') {
      return openSearch(action, action === 'grep' ? token.word : '', {
        x: anchor.x,
        y: anchor.y
      })
    }
    if (action === 'hover' && (!capabilities?.hover || open || busy)) return false
    const id = ++sequence
    if (action !== 'hover') {
      busy = true
      error = ''
      hover = null
      mode = action === 'documentation' ? 'documentation' : 'locations'
      locationTitle = action === 'references' ? 'References' : 'Definitions'
      selectedIndex = 0
      results = []
      documentation = ''
      truncated = false
      open = true
    }
    void request(action === 'documentation' ? 'hover' : action, token)
      .then(async (result) => {
        if (!alive || id !== sequence) return
        capabilities = result.capabilities
        failedRetry = -1
        connecting = false
        serverError = ''
        if (action === 'hover') {
          if (result.documentation) {
            anchor = { x: token.x, y: token.y + 12 }
            hover = {
              text: result.documentation,
              x: token.x,
              y: token.y + 12
            }
          }
          return
        }
        if (action === 'documentation') {
          mode = 'documentation'
          documentation = result.documentation || 'No documentation at this position.'
          open = true
        } else if (action === 'definition' && result.locations?.length === 1)
          await navigate(result.locations[0])
        else {
          mode = 'locations'
          selectedIndex = 0
          results = result.locations ?? []
          open = true
        }
      })
      .catch((reason) => {
        if (!alive || id !== sequence || action === 'hover') return
        error = reason instanceof Error ? reason.message : String(reason)
        mode = 'locations'
        selectedIndex = 0
        results = []
        open = true
      })
      .finally(() => {
        if (id === sequence) busy = false
      })
    return true
  }
  function handleResultKey(event: KeyboardEvent): void {
    if (keymapState.matches('ide-info-close', event) && (open || hover)) {
      event.preventDefault()
      event.stopPropagation()
      hover = null
      closeModal()
      return
    }
    if (!open || mode === 'documentation' || busy || !results.length || event.defaultPrevented)
      return
    if (keymapState.matches('ide-result-open', event)) {
      event.preventDefault()
      event.stopPropagation()
      void navigate(results[selectedIndex])
      return
    }
    const delta = keymapState.matches('ide-result-next', event)
      ? 1
      : keymapState.matches('ide-result-previous', event)
        ? -1
        : 0
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    selectedIndex = (selectedIndex + delta + results.length) % results.length
    resultList?.children.item(selectedIndex)?.scrollIntoView({ block: 'nearest' })
  }
  async function navigate(location: IdeLocation): Promise<void> {
    if (open && mode === 'locations' && results.length)
      rememberIdeResults(floatingKey, {
        results: $state.snapshot(results),
        selectedIndex,
        title: locationTitle,
        anchor: $state.snapshot(anchor)
      })
    else closeModal()
    hover = null
    await projectFilesWorkspace.openLocation(
      projectId,
      location.path,
      location.line,
      location.character
    )
  }
  function scheduleSearch(immediate = false): void {
    if (!active || !open || (mode !== 'grep' && mode !== 'files')) {
      cancelSearch()
      return
    }
    const search = query.trim()
    const searchMode = mode
    const id = ++sequence
    clearTimeout(searchTimer)
    selectedIndex = 0
    results = []
    truncated = false
    if (!search) {
      // An emptied box must also stop the scan it already started.
      stopRunningSearch()
      busy = false
      return
    }
    // A replaced query keeps its cancel out of the typing path: the next `grep`
    // kills the previous ripgrep process inside the editor worker.
    searchStarted = false
    // The loading state belongs to the frame that opens the modal, so it is set
    // here, synchronously. Only the request itself waits.
    busy = true
    searchTimer = setTimeout(
      () => {
        searchStarted = searchMode === 'grep'
        const pending: Promise<IdeResponse> =
          searchMode === 'grep'
            ? request('grep')
            : invoke('projectFiles:search', projectId, search, 'all', scopeBucketId, threadId).then(
                (entries) => ({
                  locations: entries
                    .filter((entry) => entry.kind === 'file')
                    .map((entry) => ({ path: entry.path, line: 1, character: 0 }))
                })
              )
        void pending
          .then((result) => {
            if (!alive || id !== sequence) return
            selectedIndex = 0
            results = result.locations ?? []
            truncated = result.truncated ?? false
            error = ''
          })
          .catch((reason) => {
            if (alive && id === sequence)
              error = reason instanceof Error ? reason.message : String(reason)
          })
          .finally(() => {
            if (id === sequence) {
              busy = false
              searchStarted = false
            }
          })
      },
      immediate ? 0 : 180
    )
  }
</script>

<span
  class="hidden"
  aria-hidden="true"
  {@attach () => connect(active, { projectId, scopeBucketId, threadId, path })}
  {@attach () =>
    syncDocument(active, { projectId, scopeBucketId, threadId, path }, value, retryVersion)}
></span>

{#if active}
  <div
    class="min-w-0 text-xs text-muted"
    {@attach (node) => {
      if (!statusPortal || !node.parentElement) return
      const fallback = node.parentElement
      statusPortal.registerHost({ host: node, fallback })
      return () => {
        statusPortal.unregisterHost(node)
        // The conditional block may already be removed. Never reinsert its DOM.
        node.remove()
      }
    }}
    aria-live="polite"
  >
    <div class="flex min-w-0 items-center gap-1 whitespace-nowrap">
      {#if connecting}<CioSpinner size={13} class="shrink-0 animate-spin" aria-hidden="true" />{/if}
      {#if progressEntries.length}
        <span class="shrink-0 font-mono text-muted"
          >{progressEntries[0].percentage !== undefined
            ? `${progressEntries[0].percentage}%`
            : 'Loading'}</span
        >
      {/if}
      <button
        type="button"
        class="shrink-0 px-2 py-1 text-foreground hover:bg-elevated"
        aria-expanded={infoOpen}
        onclick={() => (infoOpen = !infoOpen)}>LSP info</button
      >
    </div>
  </div>
{/if}

<svelte:window onkeydown={handleResultKey} onpointerdown={dismissOutside} />
{#snippet resultRows(fill = false)}
  <div class="flex min-h-0 flex-1 flex-col {fill ? 'overflow-auto' : ''}">
    {#if error}<p class="shrink-0 px-2 py-1 text-xs text-danger" role="status">{error}</p>{/if}
    {#if busy}<p
        class="flex shrink-0 items-center gap-2 px-2 py-1 text-xs text-muted"
        role="status"
      >
        <CioSpinner size={13} class="animate-spin" />Loading...
      </p>{/if}
    {#if mode === 'documentation' || hover}
      <div class="min-h-0 flex-1 overflow-auto px-2 py-1 text-xs text-foreground">
        <DeferredMarkdownView text={hover?.text ?? documentation} class="markdown-body-card" />
      </div>
    {:else}
      <div
        class={fill ? '' : 'max-h-96 min-h-0 overflow-auto'}
        {@attach (node) => {
          resultList = node
          return () => {
            resultList = undefined
          }
        }}
      >
        {#each results as result, index (`${result.path}:${result.line}:${index}`)}
          <button
            type="button"
            class={[
              'block w-full border-b border-border px-2 py-1 text-left text-xs text-foreground hover:bg-elevated focus:bg-elevated',
              index === selectedIndex && 'bg-elevated'
            ]}
            onfocus={() => (selectedIndex = index)}
            data-modal-primary={index === selectedIndex ? '' : undefined}
            onclick={() => void navigate(result)}
          >
            <span class="block truncate font-mono">{result.path}:{result.line}</span>
            {#if result.preview}<span class="block truncate text-muted">{result.preview}</span>{/if}
          </button>
        {:else}{#if !busy && !error}<p class="px-2 py-1 text-xs text-muted">
              {mode === 'locations'
                ? `No ${locationTitle.toLowerCase()} found for this symbol.`
                : query
                  ? 'No matches found.'
                  : 'Type to search.'}
            </p>{/if}{/each}
      </div>
    {/if}
  </div>
{/snippet}
{#if active && (hover || (open && (mode === 'locations' || mode === 'documentation')))}
  <div
    popover="manual"
    role="region"
    tabindex="-1"
    aria-label={hover || mode === 'documentation' ? 'Documentation' : locationTitle}
    class="fixed inset-auto z-50 m-0 flex max-h-[min(24rem,60vh)] w-max max-w-[min(34rem,calc(100vw-1rem))] flex-col overflow-hidden border border-border bg-elevated text-foreground shadow-lg"
    style:left={`${anchor.x}px`}
    style:top={`${anchor.y}px`}
    onpointerenter={keepHover}
    onpointerleave={() => {
      if (hover) dismissHover()
    }}
    {@attach positionFloating}
  >
    {#if !hover}<div
        class="flex items-center justify-between gap-3 border-b border-border px-2 py-1 text-xs"
      >
        <span>{mode === 'documentation' ? 'Documentation' : locationTitle}</span><button
          type="button"
          title="Close code information"
          aria-label="Close code information"
          class="p-0.5 hover:bg-surface"
          onclick={() => closeModal()}><CioClose size={13} /></button
        >
      </div>{/if}
    {@render resultRows()}
  </div>
{/if}
{#if active && infoOpen}
  <aside
    class="absolute inset-y-0 right-0 z-40 flex w-80 max-w-full flex-col border-l border-border bg-surface text-foreground"
    aria-label="Language servers for this file"
    {@attach () => {
      let cancelled = false
      infoChecking = true
      void invoke(
        'projectFiles:ide',
        projectId,
        {
          owner,
          action: 'inventory',
          path: '',
          serverId: connectedServers?.[0]?.id,
          query: connectedServers?.length ? 'updates' : undefined
        },
        scopeBucketId,
        threadId
      )
        .then((result) => {
          if (!cancelled) installations = result.installations ?? []
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) infoChecking = false
        })
      return () => {
        cancelled = true
      }
    }}
  >
    <div class="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
      <span class="text-xs font-semibold">LSP info</span>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center border border-border bg-elevated text-muted hover:bg-overlay hover:text-foreground"
        title="Close LSP info"
        aria-label="Close LSP info"
        onclick={() => (infoOpen = false)}><CioClose size={13} /></button
      >
    </div>
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-xs">
      <div>
        <p class="mb-1 text-[0.6875rem] font-medium text-muted">Current file</p>
        <p class="break-words leading-relaxed">{path}</p>
      </div>
      {#if serverError}
        <section aria-label="Language server error">
          <CardNotice tone="danger">Language server unavailable.</CardNotice>
          <details class="border border-t-0 border-danger/30">
            <summary
              class="cursor-pointer bg-danger/5 px-3 py-2 font-medium text-danger hover:bg-danger/10"
              >Error details</summary
            >
            <pre
              class="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-danger/30 bg-app px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-muted">{serverError}</pre>
          </details>
        </section>
      {:else if !connectedServers?.length}<CardNotice
          >{connecting
            ? 'Starting language server...'
            : 'No language server is connected. Configure a server in IDE Mode settings.'}</CardNotice
        >{/if}
      {#each connectedServers ?? [] as server (server.id)}
        {@const installation = installations.find((item) => item.serverId === server.id)}
        {@const reports = progressEntries.filter((entry) => entry.serverId === server.id)}
        <section class="space-y-3 border border-border bg-elevated p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-semibold">{server.name}</span><SettingsStatusBadge
              label="Connected"
              classes="border-success/30 bg-success/10 text-success"
              ><CioCircle size={11} /></SettingsStatusBadge
            >
          </div>
          <p class="leading-relaxed text-muted">
            {(server.languages ?? [server.language]).join(', ')}
          </p>
          {#if reports.length}
            <div class="space-y-2" aria-live="polite">
              {#each reports as entry (`${entry.serverId}:${entry.token}`)}
                <div>
                  <div class="flex items-center justify-between gap-2">
                    <span class="min-w-0 truncate text-muted"
                      >{entry.message ?? entry.title ?? 'Preparing project...'}</span
                    >
                    {#if entry.percentage !== undefined}<span
                        class="shrink-0 font-mono text-foreground">{entry.percentage}%</span
                      >{/if}
                  </div>
                  {#if entry.percentage !== undefined}
                    <div
                      class="mt-1 h-1 w-full bg-overlay"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={entry.percentage}
                      aria-label={`${server.name}: ${entry.title ?? 'preparing project'}`}
                    >
                      <div class="h-full bg-primary" style:width={`${entry.percentage}%`}></div>
                    </div>
                  {:else}
                    <div class="mt-1 flex items-center gap-2 text-muted">
                      <CioSpinner size={11} class="animate-spin" aria-hidden="true" />
                      <span>{entry.title ?? 'Working'}</span>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
          {#if installation?.latestVersion && installation.version && installation.latestVersion.localeCompare( installation.version, undefined, { numeric: true } ) > 0}<CardNotice
              >Update available: {installation.latestVersion}. Open LSP settings to update.</CardNotice
            >{/if}
          <details class="border border-border">
            <summary class="cursor-pointer bg-surface px-2 py-2 font-medium hover:bg-overlay"
              >Connection details</summary
            >
            <dl class="space-y-3 border-t border-border p-2 text-muted">
              <div>
                <dt class="mb-1 font-medium">Executable</dt>
                <dd class="break-all font-mono">{server.executable}</dd>
              </div>
              <div>
                <dt class="mb-1 font-medium">Workspace</dt>
                <dd class="break-all">{server.root}</dd>
              </div>
              <div>
                <dt class="mb-1 font-medium">Features</dt>
                <dd>
                  {Object.entries(capabilities ?? {})
                    .filter(([, value]) => value)
                    .map(([name]) => name)
                    .join(', ')}
                </dd>
              </div>
            </dl>
          </details>
        </section>
      {/each}
      {#if infoChecking && connectedServers?.length}<p class="flex items-center gap-2 text-muted">
          <CioSpinner size={12} class="animate-spin" />Checking updates...
        </p>{/if}
    </div>
    <div
      class="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-elevated p-3"
    >
      {#if serverError}<button
          type="button"
          class="border border-border bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-overlay"
          onclick={() => {
            retryVersion++
          }}>Retry</button
        >{/if}
      <button
        type="button"
        class="ml-auto border border-border bg-surface px-3 py-1.5 text-xs text-foreground hover:bg-overlay"
        onclick={() => void navigateTo('settings-ide-mode')}>LSP settings</button
      >
    </div>
  </aside>
{/if}
<!--
  The project search panel keeps one height for the whole search.

  A results list that grows row by row resized the panel under the cursor while
  the reader was still typing, so the surface itself now holds a fixed body: the
  input, the scroll region and the truncation note are all pinned, and only the
  rows inside move.
-->
{#snippet searchFooter()}
  <Switch
    class="mr-auto"
    checked={caseSensitive}
    label="Case sensitive"
    title="Match uppercase and lowercase exactly"
    aria-label="Case sensitive"
    onchange={(next) => {
      caseSensitive = next
      if (mode === 'grep') scheduleSearch(true)
    }}
  />
{/snippet}
<Modal
  open={active && open && (mode === 'grep' || mode === 'files')}
  onClose={() => closeModal()}
  title={mode === 'grep'
    ? `Search ${projectName || resolvedProjectName} text`
    : mode === 'files'
      ? `Find file in ${projectName || resolvedProjectName}`
      : mode === 'documentation'
        ? 'Documentation'
        : locationTitle}
  size="lg"
  contentClass="flex flex-col overflow-y-auto p-6"
  footer={mode === 'grep' ? searchFooter : undefined}
>
  <div class="flex h-[20rem] min-h-0 flex-col gap-2">
    {#if mode === 'grep' || mode === 'files'}
      <input
        class="w-full shrink-0 border border-border bg-app px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
        aria-label={mode === 'grep'
          ? `Search ${projectName || resolvedProjectName} text`
          : 'Find project file'}
        placeholder={mode === 'grep' ? 'Find text across files' : 'Find a file by name or path'}
        value={query}
        oninput={(event) => {
          query = event.currentTarget.value
          scheduleSearch()
        }}
      />
    {/if}
    {@render resultRows(true)}
    {#if truncated}<p class="shrink-0 text-xs text-muted">
        Results limited. Narrow your search to find more.
      </p>{/if}
  </div>
</Modal>
