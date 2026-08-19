<script lang="ts">
  import { onMount, tick } from 'svelte'
  import {
    Check,
    ChevronDown,
    Code2,
    FilePenLine,
    Loader2,
    RotateCcw,
    Save,
    Search,
    X
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    CIO_PROMPT_TEMPLATE_TAGS,
    type CioPromptId,
    type CioPromptMode,
    type CioPromptSetting
  } from '$shared/cio-prompts'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import Modal from '../ui/Modal.svelte'

  interface ModeFilter {
    id: 'all' | CioPromptMode
    label: string
  }

  const modeFilters: ModeFilter[] = [
    { id: 'all', label: 'All modes' },
    { id: 'chat', label: 'Chat' },
    { id: 'file-system-chat', label: 'File system' },
    { id: 'temporary-chat', label: 'Temporary' },
    { id: 'brainstorm', label: 'Brainstorm' },
    { id: 'engineer', label: 'Engineer' },
    { id: 'assignment', label: 'Assignment' },
    { id: 'achievement', label: 'Achievement' },
    { id: 'audit', label: 'Audit' },
    { id: 'utility', label: 'Utilities' }
  ]

  let prompts = $state<CioPromptSetting[]>([])
  let loading = $state(true)
  let error = $state('')
  let mode = $state<ModeFilter['id']>('all')
  let query = $state('')
  let expandedId = $state<CioPromptId | null>(null)
  let editingId = $state<CioPromptId | null>(null)
  let draft = $state('')
  let savingId = $state<CioPromptId | null>(null)
  let savedId = $state<CioPromptId | null>(null)
  let resetId = $state<CioPromptId | null>(null)

  const normalizedQuery = $derived(query.trim().toLowerCase())
  const filteredPrompts = $derived(
    prompts.filter((prompt) => {
      if (mode !== 'all' && !prompt.modes.includes(mode)) return false
      if (!normalizedQuery) return true
      return [prompt.title, prompt.description, prompt.group, prompt.filename, ...prompt.modes]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    })
  )
  const groups = $derived([...new Set(filteredPrompts.map((prompt) => prompt.group))])

  onMount(() => {
    void loadPrompts()
  })

  async function loadPrompts(): Promise<void> {
    loading = true
    error = ''
    try {
      prompts = await invoke('cioPrompts:list')
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'CIO prompts could not be loaded.'
    } finally {
      loading = false
    }
  }

  async function startEditing(prompt: CioPromptSetting): Promise<void> {
    expandedId = prompt.id
    editingId = prompt.id
    draft = prompt.template
    savedId = null
    error = ''
    await tick()
    document.getElementById(`prompt-${prompt.id}`)?.focus()
  }

  function cancelEditing(): void {
    editingId = null
    draft = ''
    error = ''
  }

  async function savePrompt(id: CioPromptId): Promise<void> {
    const template = draft.trim()
    if (!template) {
      error = 'A prompt cannot be empty. Reset it to restore the application default.'
      return
    }
    savingId = id
    savedId = null
    error = ''
    try {
      prompts = await invoke('cioPrompts:save', id, template)
      editingId = null
      draft = ''
      expandedId = id
      savedId = id
    } catch (saveError) {
      error = saveError instanceof Error ? saveError.message : 'The CIO prompt could not be saved.'
    } finally {
      savingId = null
    }
  }

  async function resetPrompt(): Promise<void> {
    if (!resetId) return
    const id = resetId
    savingId = id
    savedId = null
    error = ''
    try {
      prompts = await invoke('cioPrompts:reset', id)
      resetId = null
      editingId = null
      draft = ''
      expandedId = id
      savedId = id
    } catch (resetError) {
      error =
        resetError instanceof Error ? resetError.message : 'The CIO prompt could not be reset.'
    } finally {
      savingId = null
    }
  }

  function promptsInGroup(group: CioPromptSetting['group']): CioPromptSetting[] {
    return filteredPrompts.filter((prompt) => prompt.group === group)
  }
</script>

<div class="mx-auto max-w-4xl p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-6">
    <div>
      <h1 class="text-xl font-bold tracking-tight">CIO Prompts</h1>
      <p class="mt-0.5 max-w-2xl text-sm leading-relaxed text-muted">
        Inspect and customize the instructions sent by the application. Defaults track every app
        update; only customized sections create files in the config directory.
      </p>
    </div>
    <div
      class="shrink-0 rounded-lg border bg-elevated px-2.5 py-1.5 font-mono text-[11px] text-muted"
    >
      prompts/*.md
    </div>
  </div>

  <section class="mb-5 rounded-xl border bg-surface p-4" aria-label="Prompt template tags">
    <div class="flex items-start gap-3">
      <div class="rounded-lg bg-primary/10 p-2 text-primary"><Code2 size={17} /></div>
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-semibold text-foreground">Template tags</h2>
        <p class="mt-0.5 text-xs text-muted">
          Keep these tags in a prompt where runtime values should be inserted.
        </p>
        <div class="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {#each CIO_PROMPT_TEMPLATE_TAGS as item (item.tag)}
            <div class="rounded-lg bg-elevated px-3 py-2">
              <code class="text-[11px] font-semibold text-primary">{item.tag}</code>
              <p class="mt-0.5 text-[11px] leading-relaxed text-dimmed">{item.description}</p>
            </div>
          {/each}
        </div>
      </div>
    </div>
  </section>

  <div class="mb-5 space-y-3" aria-label="CIO prompt filters">
    <div class="relative">
      <Search
        class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dimmed"
        size={14}
      />
      <input
        class="h-9 w-full rounded-lg border bg-surface pl-9 pr-3 text-sm text-foreground outline-none focus:border-primary"
        type="search"
        placeholder="Filter by prompt, section, file, or mode"
        aria-label="Filter CIO prompts"
        bind:value={query}
      />
    </div>
    <div class="flex flex-wrap gap-1.5">
      {#each modeFilters as filter (filter.id)}
        <button
          type="button"
          class="h-8 rounded-lg border px-2.5 text-xs font-medium transition-colors"
          class:bg-primary={mode === filter.id}
          class:text-on-primary={mode === filter.id}
          class:bg-surface={mode !== filter.id}
          class:text-muted={mode !== filter.id}
          aria-pressed={mode === filter.id}
          onclick={() => (mode = filter.id)}
        >
          {filter.label}
        </button>
      {/each}
    </div>
  </div>

  {#if error}
    <p
      class="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
      role="alert"
    >
      {error}
    </p>
  {/if}

  {#if loading}
    <div
      class="flex items-center justify-center gap-2 rounded-xl border bg-surface py-14 text-sm text-muted"
    >
      <Loader2 size={16} class="animate-spin" /> Loading CIO prompts…
    </div>
  {:else if filteredPrompts.length === 0}
    <div class="rounded-xl border bg-surface px-5 py-10 text-center">
      <p class="text-sm font-medium text-foreground">No prompts match this filter</p>
      <p class="mt-1 text-xs text-muted">Choose another mode or clear the search text.</p>
    </div>
  {:else}
    <div class="space-y-6">
      {#each groups as group (group)}
        <section aria-labelledby={`prompt-group-${group.toLowerCase()}`}>
          <div class="mb-2 flex items-center gap-2">
            <h2
              id={`prompt-group-${group.toLowerCase()}`}
              class="text-xs font-semibold uppercase tracking-wide text-muted"
            >
              {group}
            </h2>
            <span class="text-[11px] tabular-nums text-dimmed">{promptsInGroup(group).length}</span>
          </div>
          <div class="divide-y rounded-xl border bg-surface">
            {#each promptsInGroup(group) as prompt (prompt.id)}
              <article>
                <div class="flex items-start gap-4 p-4">
                  <div class="rounded-lg bg-elevated p-2 text-muted"><FilePenLine size={16} /></div>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <h3 class="text-sm font-semibold text-foreground">{prompt.title}</h3>
                      {#if prompt.customized}
                        <span
                          class="rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent"
                          >Customized</span
                        >
                      {/if}
                    </div>
                    <p class="mt-0.5 text-xs leading-relaxed text-muted">{prompt.description}</p>
                    <div class="mt-2 flex flex-wrap items-center gap-1.5">
                      <code class="text-[10px] text-dimmed">prompts/{prompt.filename}</code>
                      {#each prompt.modes as promptMode (promptMode)}
                        <span class="rounded-md bg-raised px-1.5 py-0.5 text-[10px] text-muted"
                          >{promptMode}</span
                        >
                      {/each}
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    {#if editingId !== prompt.id}
                      <button
                        type="button"
                        class="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground"
                        onclick={() => void startEditing(prompt)}>Edit</button
                      >
                    {/if}
                    <button
                      type="button"
                      class="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-foreground"
                      title={expandedId === prompt.id
                        ? `Collapse ${prompt.title}`
                        : `Expand ${prompt.title}`}
                      aria-label={expandedId === prompt.id
                        ? `Collapse ${prompt.title}`
                        : `Expand ${prompt.title}`}
                      aria-expanded={expandedId === prompt.id}
                      onclick={() => (expandedId = expandedId === prompt.id ? null : prompt.id)}
                    >
                      <ChevronDown
                        size={15}
                        class={`transition-transform ${expandedId === prompt.id ? 'rotate-180' : ''}`}
                      />
                    </button>
                  </div>
                </div>

                {#if expandedId === prompt.id && editingId === prompt.id}
                  <div class="border-t bg-elevated/40 p-4">
                    <label
                      class="mb-2 block text-xs font-semibold text-foreground"
                      for={`prompt-${prompt.id}`}>Prompt template</label
                    >
                    <textarea
                      id={`prompt-${prompt.id}`}
                      class="min-h-80 w-full resize-y rounded-lg border bg-surface p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-primary disabled:opacity-50"
                      bind:value={draft}
                      disabled={savingId === prompt.id}></textarea>
                    <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-foreground disabled:opacity-50"
                        disabled={!prompt.customized || savingId === prompt.id}
                        onclick={() => (resetId = prompt.id)}
                      >
                        <RotateCcw size={13} /> Reset to default
                      </button>
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface hover:text-foreground"
                          disabled={savingId === prompt.id}
                          onclick={cancelEditing}><X size={13} /> Cancel</button
                        >
                        <button
                          type="button"
                          class="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                          disabled={savingId === prompt.id}
                          onclick={() => void savePrompt(prompt.id)}
                        >
                          {#if savingId === prompt.id}<Loader2
                              size={13}
                              class="animate-spin"
                            />{:else}<Save size={13} />{/if}
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                {:else if expandedId === prompt.id}
                  <div class="border-t px-4 py-3">
                    <div class="max-h-72 overflow-auto pr-1">
                      <MarkdownView text={prompt.template} class="text-xs" />
                    </div>
                    {#if savedId === prompt.id}
                      <p
                        class="mt-2 flex items-center gap-1 text-[11px] text-success"
                        role="status"
                      >
                        <Check size={12} /> Saved
                      </p>
                    {/if}
                  </div>
                {/if}
              </article>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  {/if}
</div>

<Modal open={resetId !== null} title="Reset CIO prompt?" onClose={() => (resetId = null)}>
  <p class="text-sm leading-relaxed text-muted">
    This deletes the custom prompt file and restores the application default. Future app updates
    will automatically supply the latest default.
  </p>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-elevated hover:text-foreground"
      onclick={() => (resetId = null)}>Cancel</button
    >
    <button
      type="button"
      class="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
      disabled={savingId !== null}
      onclick={() => void resetPrompt()}>Reset prompt</button
    >
  {/snippet}
</Modal>
