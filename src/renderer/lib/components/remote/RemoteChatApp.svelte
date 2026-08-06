<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Check,
    ChevronDown,
    ChevronRight,
    Loader2,
    MessageSquare,
    PanelLeft,
    Paperclip,
    Send,
    Sparkles,
    X,
    Zap
  } from '@lucide/svelte'
  import { remoteBridge, isRemoteConnected } from '$lib/remote/remote-bridge'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { DEFAULT_SETTINGS } from '$lib/stores/thread-settings.svelte'
  import { threadStatusSort } from '$lib/stores/workspace.svelte'
  import { supportsFastInference, fastSelectionModelId } from '$shared/fast-inference'
  import { STANDARD_THINKING_PRESETS } from '$shared/thinking-presets'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import ContextUsageIndicator from '$lib/components/chats/ContextUsageIndicator.svelte'
  import type {
    AgentContextUsage,
    AgentMessage,
    Project,
    PromptAttachment,
    ProviderCatalog,
    Thread,
    ThreadSettings
  } from '$shared/types'

  interface RemoteChatAppProps {
    onDisconnect?: () => void
  }

  let { onDisconnect = () => undefined }: RemoteChatAppProps = $props()

  let projects = $state<Project[]>([])
  let threads = $state<Thread[]>([])
  let catalog = $state<ProviderCatalog[]>([])
  let selectedProjectId = $state<string | null>(null)
  let selectedThreadId = $state<string | null>(null)
  let sidebarOpen = $state(true)
  let view = $state<'projects' | 'threads'>('projects')
  let loading = $state(true)
  let error = $state('')
  let busy = $state(false)
  let draft = $state('')
  let loadingMessages = $state(false)
  let connected = $state(isRemoteConnected())
  let attachments = $state<PromptAttachment[]>([])
  let fileInput: HTMLInputElement | undefined = $state(undefined)
  let showModelPicker = $state(false)
  let showThinkingPicker = $state(false)
  let settings = $state<ThreadSettings>({ ...DEFAULT_SETTINGS })

  const STATUS_GROUPS: Array<{ key: string; label: string; match: (t: Thread) => boolean }> = [
    { key: 'todo', label: 'To do', match: (t) => t.status === 'created' },
    {
      key: 'attention',
      label: 'Needs attention',
      match: (t) =>
        ['planning', 'executing', 'awaiting_approval', 'failed', 'interrupted'].includes(t.status)
    },
    { key: 'unread', label: 'Unread', match: (t) => !t.read && t.status !== 'created' },
    { key: 'done', label: 'Done', match: (t) => t.status === 'completed' }
  ]

  const selectedThread = $derived(threads.find((t) => t.id === selectedThreadId) ?? null)
  const selectedProject = $derived(projects.find((p) => p.id === selectedProjectId) ?? null)

  const visibleMessages = $derived(
    selectedThread ? threadMessages.messages(selectedThread.projectId, selectedThread.id) : []
  )

  const selectedCatalog = $derived(catalog.find((c) => c.id === settings.providerId))

  const selectedModel = $derived(selectedCatalog?.models.find((m) => m.id === settings.modelId))

  const thinkingPresets = $derived(
    selectedModel?.thinkingPresets?.length
      ? selectedModel.thinkingPresets
      : STANDARD_THINKING_PRESETS
  )

  const fastSupported = $derived(
    selectedCatalog && selectedModel
      ? supportsFastInference(settings.harnessId, selectedCatalog.id, selectedModel.fastSupported)
      : false
  )

  const contextUsage = $derived.by((): AgentContextUsage | undefined => {
    let contextWindow: number | undefined
    let contextUsed = 0
    let costUsd = 0
    let reasoning = 0
    let cacheRead = 0
    let cacheWrite = 0
    let input = 0
    let output = 0
    for (const message of visibleMessages) {
      if (message.contextWindow !== undefined) contextWindow = message.contextWindow
      if (message.contextUsed !== undefined) contextUsed = message.contextUsed
      if (message.cost !== undefined) costUsd += message.cost
      input += message.tokens?.input ?? 0
      output += message.tokens?.output ?? 0
      reasoning += message.tokens?.reasoning ?? 0
      cacheRead += message.tokens?.cacheRead ?? 0
      cacheWrite += message.tokens?.cacheWrite ?? 0
    }
    if (input === 0 && output === 0 && costUsd === 0) return undefined
    return {
      contextWindow,
      contextUsed,
      contextPercent:
        contextWindow && contextWindow > 0 ? (contextUsed / contextWindow) * 100 : undefined,
      costUsd,
      tokens: {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total: input + output + reasoning + cacheRead + cacheWrite
      },
      rateLimits: []
    }
  })

  const canSend = $derived(!busy && draft.trim().length > 0 && selectedThread !== null && connected)

  function groupedThreads(): Array<{ key: string; label: string; threads: Thread[] }> {
    const scoped = threads.filter((t) =>
      view === 'projects' ? t.projectId === selectedProjectId : true
    )
    return STATUS_GROUPS.map((group) => ({
      ...group,
      threads: scoped.filter(group.match).sort(threadStatusSort)
    })).filter((group) => group.threads.length > 0)
  }

  async function loadData(): Promise<void> {
    loading = true
    error = ''
    try {
      const [projectList, threadList] = await Promise.all([
        remoteBridge.invoke('project:list'),
        remoteBridge.invoke('thread:listAll')
      ])
      projects = (projectList as Project[]).filter((p) => !p.hidden)
      threads = threadList as Thread[]
      if (!selectedProjectId && projects.length > 0) {
        selectedProjectId = projects[0].id
      }
      if (selectedThreadId && !threads.some((t) => t.id === selectedThreadId)) {
        selectedThreadId = null
      }
      if (!selectedThreadId) {
        const first = threads.find((t) => t.projectId === selectedProjectId)
        if (first) selectedThreadId = first.id
      }
      await refreshCatalog()
      if (selectedThreadId && selectedProjectId) {
        const active = threads.find((t) => t.id === selectedThreadId)
        if (active) await openThreadMessages(active)
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load your threads.'
    } finally {
      loading = false
    }
  }

  async function refreshCatalog(): Promise<void> {
    if (!selectedProjectId) return
    try {
      const snapshots = (await remoteBridge.invoke(
        'agent:listProviderSnapshot',
        selectedProjectId
      )) as ProviderCatalog[]
      catalog = snapshots
      if (selectedThread?.settings) {
        settings = { ...DEFAULT_SETTINGS, ...selectedThread.settings }
      }
    } catch {
      catalog = []
    }
  }

  async function openThread(thread: Thread): Promise<void> {
    selectedThreadId = thread.id
    selectedProjectId = thread.projectId
    sidebarOpen = false
    draft = ''
    attachments = []
    settings = thread.settings
      ? { ...DEFAULT_SETTINGS, ...thread.settings }
      : { ...DEFAULT_SETTINGS }
    await refreshCatalog()
    await openThreadMessages(thread)
  }

  async function openThreadMessages(thread: Thread): Promise<void> {
    loadingMessages = true
    try {
      await threadMessages.load(thread.projectId, thread.id)
      const status = (await remoteBridge.invoke(
        'agent:getSessionStatus',
        thread.projectId,
        thread.id
      )) as { sessionId?: string } | null
      void threadMessages.setSessionId(thread.projectId, thread.id, status?.sessionId ?? undefined)
    } finally {
      loadingMessages = false
    }
  }

  async function handleSend(): Promise<void> {
    const text = draft.trim()
    if (!selectedThread || text.length === 0 || busy) return
    busy = true
    try {
      const effective = { ...DEFAULT_SETTINGS, ...(settings ?? {}) }
      await threadMessages.send(
        selectedThread.projectId,
        selectedThread.id,
        effective,
        text,
        attachments,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
      draft = ''
      attachments = []
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not send your message.'
    } finally {
      busy = false
    }
  }

  async function commitSettings(): Promise<void> {
    if (!selectedThread) return
    try {
      const updated = (await remoteBridge.invoke(
        'thread:updateSettings',
        selectedThread.projectId,
        selectedThread.id,
        settings
      )) as Thread
      settings = { ...DEFAULT_SETTINGS, ...(updated.settings ?? settings) }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not save settings.'
    }
  }

  async function selectModel(providerId: string, modelId: string): Promise<void> {
    settings = { ...settings, providerId, modelId }
    await commitSettings()
    showModelPicker = false
  }

  async function setPermission(permissionLevel: 'auto_review' | 'full_access'): Promise<void> {
    settings = { ...settings, permissionLevel }
    await commitSettings()
  }

  async function setThinking(thinkingLevel: ThreadSettings['thinkingLevel']): Promise<void> {
    settings = { ...settings, thinkingLevel }
    await commitSettings()
    showThinkingPicker = false
  }

  async function toggleFast(enabled: boolean): Promise<void> {
    const harnessId = settings.harnessId
    if (enabled && selectedCatalog) {
      settings = {
        ...settings,
        inferenceMode: 'fast',
        modelId: fastSelectionModelId(harnessId, settings.modelId)
      }
    } else {
      settings = { ...settings, inferenceMode: 'normal' }
    }
    await commitSettings()
  }

  function onFileChange(): void {
    const file = fileInput?.files?.[0]
    if (!file) return
    attachments = [
      ...attachments,
      {
        mime: file.type || 'application/octet-stream',
        url: URL.createObjectURL(file),
        filename: file.name
      }
    ]
    if (fileInput) fileInput.value = ''
  }

  function captureFileInput(node: HTMLInputElement): void | (() => void) {
    fileInput = node
    return () => {
      fileInput = undefined
    }
  }

  function removeAttachment(index: number): void {
    const removed = attachments[index]
    if (removed?.url.startsWith('blob:')) URL.revokeObjectURL(removed.url)
    attachments = attachments.filter((_, i) => i !== index)
  }

  function statusLabel(status: Thread['status']): string {
    switch (status) {
      case 'created':
        return 'Created'
      case 'planning':
        return 'Planning'
      case 'executing':
        return 'Executing'
      case 'awaiting_approval':
        return 'Awaiting approval'
      case 'interrupted':
        return 'Interrupted'
      case 'completed':
        return 'Completed'
      case 'failed':
        return 'Failed'
    }
  }

  function messageBody(message: AgentMessage): string {
    return message.parts
      .filter((part) => part.type === 'text')
      .map((part) => ('text' in part ? part.text : ''))
      .join('\n')
  }

  function reasoningText(message: AgentMessage): string {
    return message.parts
      .filter((part) => part.type === 'reasoning')
      .map((part) => ('text' in part ? part.text : ''))
      .join('\n')
  }

  function partLabel(partType: string): string {
    switch (partType) {
      case 'tool':
        return 'Tool call'
      case 'subagent':
        return 'Agent activity'
      case 'file':
        return 'File'
      case 'question':
        return 'Question'
      case 'compaction-summary':
        return 'Compaction'
      default:
        return partType
    }
  }

  onMount(() => {
    void loadData()
    const interval = window.setInterval(() => {
      connected = isRemoteConnected()
      if (!connected) {
        window.clearInterval(interval)
      }
    }, 1500)
    return () => window.clearInterval(interval)
  })
</script>

{#if !connected}
  <div class="flex h-full flex-col items-center justify-center gap-4 bg-app p-6">
    <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface shadow-sm">
      <MessageSquare size={26} class="text-primary" />
    </div>
    <p class="text-sm font-medium text-foreground">Connection lost</p>
    <p class="max-w-60 text-center text-xs leading-relaxed text-dimmed">
      The connection to your desktop dropped. Make sure the desktop is still running and on the same
      network.
    </p>
    <button
      type="button"
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      onclick={onDisconnect}
    >
      Reconnect
    </button>
  </div>
{:else}
  <div class="flex h-full bg-app text-foreground">
    <!-- Sidebar -->
    <aside
      class="absolute inset-y-0 left-0 z-30 flex w-72 flex-col border-r border-border bg-surface shadow-xl transition-transform duration-200 lg:static lg:translate-x-0 lg:shadow-none {sidebarOpen
        ? 'translate-x-0'
        : '-translate-x-full'}"
    >
      <div class="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <div class="flex items-center gap-2">
          <div class="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
            <MessageSquare size={15} class="text-primary" />
          </div>
          <span class="text-sm font-semibold">Threads</span>
        </div>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground lg:hidden"
          aria-label="Close the sidebar"
          title="Close the sidebar"
          onclick={() => (sidebarOpen = false)}
        >
          <X size={16} />
        </button>
      </div>

      <!-- Projects / Threads switcher -->
      <div class="space-y-2 border-b border-border p-3">
        <div class="relative">
          <select
            class="w-full appearance-none rounded-lg border border-border bg-elevated px-3 py-2 pr-8 text-[13px] font-medium outline-none focus:border-primary"
            bind:value={view}
            aria-label="Switch between projects and threads"
          >
            <option value="projects">Projects</option>
            <option value="threads">Threads</option>
          </select>
          <ChevronDown
            size={14}
            class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-dimmed"
          />
        </div>
        {#if view === 'projects'}
          <div class="relative">
            <select
              class="w-full appearance-none rounded-lg border border-border bg-elevated px-3 py-2 pr-8 text-[13px] font-medium outline-none focus:border-primary"
              bind:value={selectedProjectId}
              aria-label="Select project"
            >
              {#each projects as project (project.id)}
                <option value={project.id}>{project.name}</option>
              {/each}
            </select>
            <ChevronDown
              size={14}
              class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-dimmed"
            />
          </div>
        {/if}
      </div>

      <!-- Thread list -->
      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        {#if loading}
          <div class="flex items-center gap-2 px-3 py-4 text-[13px] text-muted">
            <Loader2 size={14} class="animate-spin" />
            Loading threads…
          </div>
        {:else if error}
          <p class="px-3 py-4 text-[13px] text-danger">{error}</p>
        {:else}
          {#each groupedThreads() as group (group.key)}
            <p
              class="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-dimmed"
            >
              {group.label}
            </p>
            <div class="space-y-px">
              {#each group.threads as thread (thread.id)}
                {@const selected = thread.id === selectedThreadId}
                <button
                  type="button"
                  class="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors {selected
                    ? 'bg-primary/10'
                    : 'hover:bg-elevated'}"
                  title={thread.title || 'Untitled thread'}
                  onclick={() => void openThread(thread)}
                >
                  <div class="min-w-0 flex-1">
                    <p
                      class="truncate text-[13px] font-medium {selected
                        ? 'text-foreground'
                        : 'text-muted group-hover:text-foreground'}"
                    >
                      {thread.title || 'Untitled thread'}
                    </p>
                    <p class="truncate text-[11px] text-dimmed">{statusLabel(thread.status)}</p>
                  </div>
                  {#if !thread.read}
                    <span class="h-2 w-2 shrink-0 rounded-full bg-primary"></span>
                  {/if}
                </button>
              {/each}
            </div>
          {:else}
            <div class="px-4 py-10 text-center">
              <MessageSquare size={22} class="mx-auto text-dimmed" />
              <p class="mt-2 text-[13px] text-dimmed">No threads yet.</p>
            </div>
          {/each}
        {/if}
      </div>
    </aside>

    {#if sidebarOpen}
      <div
        class="fixed inset-0 z-20 bg-black/30 backdrop-blur-sm lg:hidden"
        role="presentation"
        onclick={() => (sidebarOpen = false)}
      ></div>
    {/if}

    <!-- Main chat -->
    <main class="flex min-w-0 flex-1 flex-col">
      <!-- Header -->
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Show the sidebar"
          title="Show the sidebar"
          onclick={() => (sidebarOpen = true)}
        >
          <PanelLeft size={16} />
        </button>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold">{selectedThread?.title || 'Select a thread'}</p>
          <p class="truncate text-[11px] text-dimmed">
            {selectedProject?.name ?? ''}
            {#if selectedThread}· {statusLabel(selectedThread.status)}{/if}
          </p>
        </div>
        {#if contextUsage}
          <div class="flex shrink-0 items-center gap-2">
            <ContextUsageIndicator usage={contextUsage} />
          </div>
        {/if}
      </header>

      <!-- Messages -->
      <div class="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5" aria-live="polite">
        {#if loadingMessages}
          <div class="flex items-center justify-center gap-2 py-10 text-[13px] text-muted">
            <Loader2 size={14} class="animate-spin" />
            Loading conversation…
          </div>
        {:else if visibleMessages.length === 0}
          <div class="flex flex-col items-center justify-center py-16 text-center">
            <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <Sparkles size={22} class="text-primary" />
            </div>
            <p class="mt-3 text-sm font-medium">Start the conversation</p>
            <p class="mt-1 max-w-64 text-xs leading-relaxed text-dimmed">
              This thread is empty. Send a message below and your agent will pick it up.
            </p>
          </div>
        {:else}
          {#each visibleMessages as message (message.id)}
            {@const isUser = message.role === 'user'}
            <div class="flex {isUser ? 'justify-end' : 'justify-start'}">
              <div
                class="max-w-[90%] space-y-2 rounded-2xl border px-4 py-3 {isUser
                  ? 'border-transparent bg-primary/10'
                  : 'border-border bg-surface'}"
              >
                {#if !isUser && reasoningText(message)}
                  <details class="text-[12px] text-dimmed">
                    <summary class="cursor-pointer select-none text-[11px] font-medium">
                      Reasoning
                    </summary>
                    <p class="mt-1 whitespace-pre-wrap leading-relaxed">
                      {reasoningText(message)}
                    </p>
                  </details>
                {/if}
                {#if messageBody(message)}
                  <div class="text-[14px] leading-relaxed">
                    <MarkdownView text={messageBody(message)} />
                  </div>
                {/if}
                {#each message.parts.filter((p) => p.type !== 'text' && p.type !== 'reasoning') as part (part.id)}
                  <div
                    class="flex items-center gap-1.5 rounded-lg bg-elevated px-2.5 py-1.5 text-[11px] text-muted"
                  >
                    <ChevronRight size={12} class="text-dimmed" />
                    {partLabel(part.type)}
                  </div>
                {/each}
                {#if message.error}
                  <p class="text-[11px] text-danger">{message.error}</p>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Composer -->
      <div class="border-t border-border bg-surface px-3 py-3">
        {#if attachments.length > 0}
          <div class="mb-2 flex flex-wrap gap-1.5">
            {#each attachments as attachment, index (attachment.url)}
              <div
                class="flex items-stretch overflow-hidden rounded-lg border border-border bg-elevated text-[11px] text-muted"
              >
                <span class="flex min-w-0 items-center gap-1.5 py-1 pr-1 pl-2">
                  <Paperclip size={11} class="shrink-0 text-dimmed" />
                  <span class="max-w-32 truncate">{attachment.filename ?? 'attachment'}</span>
                </span>
                <button
                  type="button"
                  class="flex shrink-0 items-center justify-center border-l border-border px-2.5 text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                  onclick={() => removeAttachment(index)}
                >
                  <X size={11} />
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <div class="flex items-end gap-2">
          <div
            class="flex min-w-0 flex-1 items-end gap-1.5 rounded-xl border border-border bg-app px-2 py-1.5 transition-colors focus-within:border-primary"
          >
            <input
              {@attach captureFileInput}
              type="file"
              class="hidden"
              aria-label="Attach a file"
              onchange={onFileChange}
            />
            <button
              type="button"
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
              aria-label="Attach a file"
              title="Attach a file"
              onclick={() => fileInput?.click()}
            >
              <Paperclip size={16} />
            </button>
            <textarea
              class="min-h-9 max-h-36 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-dimmed"
              placeholder="Message the agent…"
              rows="1"
              bind:value={draft}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}></textarea>
          </div>
          <button
            type="button"
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-on-primary transition-all hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-40"
            disabled={!canSend}
            title="Send message"
            aria-label="Send message"
            onclick={() => void handleSend()}
          >
            {#if busy}
              <Loader2 size={16} class="animate-spin" />
            {:else}
              <Send size={16} />
            {/if}
          </button>
        </div>

        <!-- Controls -->
        <div class="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            class="flex items-center gap-1 rounded-lg bg-elevated px-2 py-1 text-[11px] text-muted transition-colors hover:text-foreground"
            title="Choose model"
            onclick={() => {
              showThinkingPicker = false
              showModelPicker = !showModelPicker
            }}
          >
            {settings.modelId || 'Model'}
            <ChevronDown size={11} />
          </button>

          <button
            type="button"
            class="rounded-lg bg-elevated px-2 py-1 text-[11px] text-muted transition-colors hover:text-foreground"
            title="Permission level"
            onclick={() =>
              void setPermission(
                settings.permissionLevel === 'full_access' ? 'auto_review' : 'full_access'
              )}
          >
            {settings.permissionLevel === 'full_access' ? 'Full access' : 'Auto review'}
          </button>

          <button
            type="button"
            class="flex items-center gap-1 rounded-lg bg-elevated px-2 py-1 text-[11px] text-muted transition-colors hover:text-foreground"
            title="Thinking level"
            onclick={() => {
              showModelPicker = false
              showThinkingPicker = !showThinkingPicker
            }}
          >
            {settings.thinkingLevel}
            <ChevronDown size={11} />
          </button>

          {#if fastSupported}
            <button
              type="button"
              class="rounded-lg px-2 py-1 text-[11px] transition-colors {settings.inferenceMode ===
              'fast'
                ? 'bg-primary/15 text-primary'
                : 'bg-elevated text-muted hover:text-foreground'}"
              title="Toggle fast mode"
              onclick={() => void toggleFast(settings.inferenceMode !== 'fast')}
            >
              <Zap size={11} class="mr-0.5 inline" />
              Fast
            </button>
          {/if}
        </div>

        {#if showModelPicker}
          <div class="mt-2 max-h-56 overflow-y-auto rounded-xl border border-border bg-surface p-2">
            {#each catalog as provider (provider.id)}
              <p
                class="px-1.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-dimmed first:pt-0"
              >
                {provider.name ?? provider.id}
              </p>
              <div class="grid grid-cols-2 gap-1">
                {#each provider.models as model (model.id)}
                  <button
                    type="button"
                    class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors {settings.modelId ===
                      model.id && settings.providerId === provider.id
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted hover:bg-elevated hover:text-foreground'}"
                    onclick={() => void selectModel(provider.id, model.id)}
                  >
                    <span class="min-w-0 flex-1 truncate">{model.name}</span>
                    {#if settings.modelId === model.id && settings.providerId === provider.id}
                      <Check size={11} class="shrink-0 text-primary" />
                    {/if}
                  </button>
                {/each}
              </div>
            {/each}
          </div>
        {/if}

        {#if showThinkingPicker}
          <div class="mt-2 rounded-xl border border-border bg-surface p-2">
            <div class="grid grid-cols-2 gap-1">
              {#each thinkingPresets as preset (preset.id)}
                <button
                  type="button"
                  class="flex items-center justify-between gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors {settings.thinkingLevel ===
                  preset.id
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted hover:bg-elevated hover:text-foreground'}"
                  onclick={() => void setThinking(preset.id as ThreadSettings['thinkingLevel'])}
                >
                  <span>{preset.label}</span>
                  {#if settings.thinkingLevel === preset.id}
                    <Check size={11} class="shrink-0 text-primary" />
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </main>
  </div>
{/if}
