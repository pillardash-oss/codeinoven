<script lang="ts">
  import { navigateTo } from '$lib/app-control/app-control-actions'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
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
  }
  let { projectId, scopeBucketId, threadId, path, value, enabled = false }: Props = $props()
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
    serverError = ''
    failedRetry = -1
    return () => {
      alive = false
      capabilities = undefined
      hover = null
      closeModal()
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

  function closeModal(): void {
    sequence++
    open = false
    busy = false
    cancelSearch()
  }

  export function dismissHover(): void {
    hover = null
    if (!busy && !open) sequence++
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
        label: 'Search Project Text',
        run: () => {
          handle('grep', token)
        }
      },
      {
        label: 'Find Project File',
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
          if (result.documentation)
            hover = {
              text: result.documentation,
              x: Math.min(token.x, window.innerWidth - 360),
              y: Math.min(token.y + 12, window.innerHeight - 220)
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
    closeModal()
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
    class="flex shrink-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-1 text-xs text-muted"
    aria-live="polite"
  >
    <span class="min-w-0 flex-1 break-words"
      >{serverError
        ? serverError.includes('ENOENT')
          ? 'Language server executable not found. Install it or choose its executable in LSP settings.'
          : `Language server unavailable: ${serverError}`
        : connecting
          ? 'Starting language server...'
          : capabilities
            ? 'Language server connected'
            : 'IDE Mode: connecting...'}</span
    >
    {#if serverError}
      <button
        type="button"
        class="shrink-0 px-2 py-1 text-foreground hover:bg-elevated"
        onclick={() => {
          retryVersion++
        }}>Retry</button
      >
    {/if}
    <button
      type="button"
      class="shrink-0 px-2 py-1 text-foreground hover:bg-elevated"
      onclick={() => void navigateTo('settings-ide-mode')}>LSP settings</button
    >
  </div>
{/if}

<svelte:window
  onkeydown={handleResultKey}
  onpointerdown={() => {
    hover = null
  }}
  onscroll={() => {
    hover = null
  }}
/>
{#if hover}
  <div
    class="pointer-events-none fixed z-50 max-h-48 max-w-sm overflow-hidden whitespace-pre-wrap border border-border bg-elevated p-3 font-mono text-xs text-foreground shadow-lg"
    style:left={`${Math.max(0, hover.x)}px`}
    style:top={`${Math.max(0, hover.y)}px`}
    role="tooltip"
  >
    <MarkdownView text={hover.text} class="markdown-body-card" />
  </div>
{/if}
<Modal
  {open}
  onClose={closeModal}
  title={mode === 'grep'
    ? 'Search project text'
    : mode === 'files'
      ? 'Find project file'
      : mode === 'documentation'
        ? 'Documentation'
        : locationTitle}
  size="lg"
>
  {#if mode === 'grep' || mode === 'files'}
    <input
      class="w-full border border-border bg-app px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
      aria-label={mode === 'grep' ? 'Search project text' : 'Find project file'}
      placeholder={mode === 'grep' ? 'Find text across files' : 'Find a file by name or path'}
      value={query}
      oninput={(event) => {
        query = event.currentTarget.value
        scheduleSearch()
      }}
    />
  {/if}
  {#if error}<p class="py-2 text-xs text-muted" role="status">{error}</p>{/if}
  {#if busy}<p class="py-2 text-xs text-muted" role="status">
      {mode === 'documentation'
        ? 'Loading documentation...'
        : mode === 'locations'
          ? 'Finding code locations...'
          : 'Searching...'}
    </p>{/if}
  {#if mode === 'documentation'}
    <div class="max-h-96 overflow-auto py-3 text-sm text-foreground">
      <MarkdownView text={documentation} class="markdown-body-card" />
    </div>
  {:else}
    <div
      class="max-h-96 overflow-auto py-2"
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
            'block w-full border-b border-border px-3 py-2 text-left text-xs text-foreground hover:bg-elevated focus:bg-elevated',
            index === selectedIndex && 'bg-elevated'
          ]}
          data-modal-primary={index === selectedIndex ? '' : undefined}
          onfocus={() => (selectedIndex = index)}
          onclick={() => void navigate(result)}
        >
          <span class="block truncate font-mono">{result.path}:{result.line}</span>
          {#if result.preview}<span class="block truncate text-muted">{result.preview}</span>{/if}
        </button>
      {:else}
        {#if !busy && !error}<p class="py-2 text-xs text-muted">
            {mode === 'locations'
              ? `No ${locationTitle.toLowerCase()} found for this symbol in this project.`
              : query
                ? 'No matches found.'
                : 'Type to search.'}
          </p>{/if}
      {/each}
    </div>
    {#if truncated}<p class="text-xs text-muted">
        Results limited. Narrow your search to find more.
      </p>{/if}
  {/if}
</Modal>
