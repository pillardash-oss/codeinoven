<script lang="ts">
  import {
    rememberIdeResults,
    recalledIdeResults,
    forgetIdeResults
  } from '$lib/editor/ide-floating-results'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'
  import { navigateTo } from '$lib/app-control/app-control-actions'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import type { AppPanelPortal } from '$lib/app-panel-portal'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import type { IdeAction, IdeLocation, IdeResponse } from '$shared/editor-ide'
  import type { IdeToken, IdeMenuAction } from '$lib/editor/ide-context'

  interface Props {
    projectId: string
    scopeBucketId?: string
    threadId?: string
    path: string
    value: string
    enabled?: boolean
    projectName?: string
    statusPortal?: AppPanelPortal
  }
  let {
    projectId,
    scopeBucketId,
    threadId,
    path,
    value,
    enabled = false,
    projectName = '',
    statusPortal
  }: Props = $props()
  let resolvedProjectName = $state('')
  let connectedServers = $state<IdeResponse['servers']>([])
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
  let hover = $state<{ text: string; x: number; y: number } | null>(null)
  let sequence = 0
  let alive = false
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let searchStarted = false
  const floatingKey = $derived(`${projectId}:${scopeBucketId ?? ''}:${threadId ?? ''}`)
  const active = $derived(enabled && Boolean(projectId))

  async function request(action: IdeAction, token?: IdeToken): Promise<IdeResponse> {
    return invoke(
      'projectFiles:ide',
      projectId,
      {
        owner,
        action,
        path,
        text: token?.text ?? value,
        line: token?.line,
        character: token?.character,
        query
      },
      scopeBucketId,
      threadId
    )
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
    failedRetry = -1
    return () => {
      alive = false
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
            serverError = reason instanceof Error ? reason.message : String(reason)
          }
        })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }

  function cancelSearch(): void {
    clearTimeout(searchTimer)
    if (searchStarted) {
      searchStarted = false
      void invoke('projectFiles:ide', projectId, { owner, action: 'cancel', path: '' }).catch(
        () => undefined
      )
    }
  }

  function closeModal(preserve = false): void {
    if (!preserve) forgetIdeResults(floatingKey)
    sequence++
    open = false
    busy = false
    cancelSearch()
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
  export function actions(token: IdeToken): IdeMenuAction[] {
    if (!active) return []
    const items: IdeMenuAction[] = []
    if (!capabilities || capabilities.definition)
      items.push({
        label: 'Go to Definition',
        run: () => {
          handle('definition', token)
        }
      })
    if (!capabilities || capabilities.references)
      items.push({
        label: 'Find References',
        run: () => {
          handle('references', token)
        }
      })
    if (!capabilities || capabilities.hover)
      items.push({
        label: 'Show Documentation',
        run: () => {
          handle('documentation', token)
        }
      })
    items.push(
      {
        label: `Search ${projectName || resolvedProjectName} text`,
        run: () => {
          handle('grep', token)
        }
      },
      {
        label: `Find file in ${projectName || resolvedProjectName}`,
        run: () => {
          handle('files', token)
        }
      }
    )
    return items
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
      mode = action
      query = action === 'grep' ? token.word : ''
      selectedIndex = 0
      results = []
      hover = null
      open = true
      error = ''
      scheduleSearch()
      return true
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
  function scheduleSearch(): void {
    cancelSearch()
    if (!active || !open || (mode !== 'grep' && mode !== 'files')) return
    const search = query.trim()
    const searchMode = mode
    const id = ++sequence
    selectedIndex = 0
    results = []
    truncated = false
    if (!search) {
      busy = false
      return
    }
    busy = true
    searchTimer = setTimeout(() => {
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
    }, 180)
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
        fallback.appendChild(node)
        statusPortal.unregisterHost(node)
      }
    }}
    aria-live="polite"
  >
    <div class="flex min-w-0 items-center gap-1 whitespace-nowrap">
      {#if connecting}<CioSpinner size={13} class="shrink-0 animate-spin" aria-hidden="true" />{/if}
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
{#snippet resultRows()}
  {#if error}<p class="px-2 py-1 text-xs text-danger" role="status">{error}</p>{/if}
  {#if busy}<p class="flex items-center gap-2 px-2 py-1 text-xs text-muted" role="status">
      <CioSpinner size={13} class="animate-spin" />Loading...
    </p>{/if}
  {#if mode === 'documentation' || hover}
    <div class="min-h-0 overflow-auto px-2 py-1 text-xs text-foreground">
      <MarkdownView text={hover?.text ?? documentation} class="markdown-body-card" />
    </div>
  {:else}
    <div
      class="max-h-96 min-h-0 overflow-auto"
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
{/snippet}
{#if hover || (open && (mode === 'locations' || mode === 'documentation'))}
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
{#if infoOpen}
  <aside
    class="absolute inset-y-0 right-0 z-40 flex w-80 max-w-full flex-col overflow-auto border-l border-border bg-surface text-xs text-foreground"
    aria-label="Language servers for this file"
  >
    <div class="flex items-center justify-between border-b border-border px-2 py-1">
      <span>LSP info</span><button
        type="button"
        class="p-1"
        title="Close LSP info"
        aria-label="Close LSP info"
        onclick={() => (infoOpen = false)}><CioClose size={13} /></button
      >
    </div>
    <div class="space-y-2 p-2">
      <p role="status">
        {serverError
          ? 'Language server unavailable'
          : connecting
            ? 'Starting language server...'
            : capabilities
              ? 'Language server connected'
              : 'No server connected'}
      </p>
      <div class="flex items-center justify-between gap-2">
        {#if serverError}<button
            type="button"
            class="px-2 py-1 hover:bg-elevated"
            onclick={() => {
              retryVersion++
            }}>Retry</button
          >{/if}
        <button
          type="button"
          class="ml-auto px-2 py-1 hover:bg-elevated"
          onclick={() => void navigateTo('settings-ide-mode')}>LSP settings</button
        >
      </div>

      <p class="break-all font-mono">{path}</p>
      {#each connectedServers ?? [] as server (server.id)}<section
          class="space-y-1 border-t border-border py-2"
        >
          <p class="font-medium">{server.name}</p>
          <p>Languages: {(server.languages ?? [server.language]).join(', ')}</p>
          <p class="break-all font-mono text-muted">{server.executable}</p>
          <p class="break-all text-muted">Workspace: {server.root}</p>
          <p>
            {Object.entries(capabilities ?? {})
              .filter(([, value]) => value)
              .map(([name]) => name)
              .join(', ')}
          </p>
        </section>{:else}<p class="text-muted">
          {connecting ? 'Connecting...' : 'No server connected to this file.'}
        </p>{/each}
      {#if serverError}<details class="min-w-0">
          <summary class="cursor-pointer text-danger">Error details</summary>
          <pre
            class="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">{serverError}</pre>
        </details>{/if}
    </div>
  </aside>
{/if}
<Modal
  open={open && (mode === 'grep' || mode === 'files')}
  onClose={() => closeModal()}
  title={mode === 'grep'
    ? `Search ${projectName || resolvedProjectName} text`
    : mode === 'files'
      ? `Find file in ${projectName || resolvedProjectName}`
      : mode === 'documentation'
        ? 'Documentation'
        : locationTitle}
  size="lg"
>
  {#if mode === 'grep' || mode === 'files'}
    <input
      class="w-full border border-border bg-app px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
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
  {@render resultRows()}
  {#if truncated}<p class="text-xs text-muted">
      Results limited. Narrow your search to find more.
    </p>{/if}
</Modal>
