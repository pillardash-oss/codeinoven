<script lang="ts">
  import { Check, ExternalLink, FolderOpen, Save } from '@lucide/svelte'
  import StudioDocumentNavigation from './StudioDocumentNavigation.svelte'
  import type { PrdContent, PrdDocument, PrdSectionId } from '$shared/types'

  interface Props {
    prd: PrdDocument
    versions?: PrdDocument[]
    busy?: boolean
    error?: string
    brainstormAvailable?: boolean
    specAvailable?: boolean
    assignmentAvailable?: boolean
    auditAvailable?: boolean
    agentMessagesOpen?: boolean
    onBack: () => void
    onToggleAgentMessages: () => void
    onOpenBrainstorm?: () => void
    onOpenSpec?: () => void
    onOpenAssignment?: () => void
    onOpenAudit?: () => void
    onSelectVersion: (version: number) => void | Promise<void>
    onSave: (content: PrdContent) => void | Promise<void>
    onFinalize: () => void | Promise<void>
    onOpenInEditor?: () => void | Promise<void>
    onRevealInFiles?: () => void | Promise<void>
  }

  let {
    prd,
    versions = [],
    busy = false,
    error,
    brainstormAvailable = false,
    specAvailable = false,
    assignmentAvailable = false,
    auditAvailable = false,
    agentMessagesOpen = false,
    onBack,
    onToggleAgentMessages,
    onOpenBrainstorm,
    onOpenSpec,
    onOpenAssignment,
    onOpenAudit,
    onSelectVersion,
    onSave,
    onFinalize,
    onOpenInEditor,
    onRevealInFiles
  }: Props = $props()

  // The parent keys this component by PRD identity and version.
  // svelte-ignore state_referenced_locally
  let content = $state<PrdContent>(structuredClone(prd.content))
  let dirty = $state(false)

  function updateSection(id: PrdSectionId, markdown: string): void {
    content = {
      ...content,
      sections: content.sections.map((section) =>
        section.id === id ? { ...section, markdown } : section
      )
    }
    dirty = true
  }
</script>

<div class="flex min-h-0 flex-1 flex-col bg-app">
  <header class="flex flex-wrap items-center justify-between gap-2 border-b bg-surface px-4 py-2.5">
    <StudioDocumentNavigation
      active="prd"
      {brainstormAvailable}
      prdAvailable
      {specAvailable}
      {assignmentAvailable}
      {auditAvailable}
      {agentMessagesOpen}
      {onBack}
      {onToggleAgentMessages}
      {onOpenBrainstorm}
      {onOpenSpec}
      {onOpenAssignment}
      {onOpenAudit}
    />
    <div class="flex items-center gap-1.5">
      {#if versions.length > 1}
        <select
          class="h-8 rounded-lg border bg-surface px-2 text-xs text-foreground"
          aria-label="PRD version"
          value={prd.version}
          onchange={(event) => void onSelectVersion(Number(event.currentTarget.value))}
        >
          {#each versions as version (version.version)}
            <option value={version.version}>v{version.version} · {version.status}</option>
          {/each}
        </select>
      {/if}
      {#if onOpenInEditor}
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground"
          title="Open PRD in editor"
          aria-label="Open PRD in editor"
          onclick={() => void onOpenInEditor()}
        >
          <ExternalLink size={14} />
        </button>
      {/if}
      {#if onRevealInFiles}
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground"
          title="Reveal PRD in files"
          aria-label="Reveal PRD in files"
          onclick={() => void onRevealInFiles()}
        >
          <FolderOpen size={14} />
        </button>
      {/if}
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
        disabled={!dirty || busy || prd.status !== 'draft'}
        onclick={() => {
          void onSave(content)
          dirty = false
        }}
      >
        <Save size={13} /> Save
      </button>
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg bg-thread-spec px-2.5 text-xs font-medium text-foreground disabled:opacity-50"
        disabled={busy || prd.status !== 'draft'}
        onclick={() => void onFinalize()}
      >
        <Check size={13} /> Finalize
      </button>
    </div>
  </header>

  <main class="min-h-0 flex-1 overflow-y-auto px-4 py-8">
    <article class="mx-auto max-w-3xl rounded-2xl border bg-surface p-6 shadow-sm">
      <input
        class="w-full bg-transparent text-2xl font-semibold text-foreground outline-none"
        value={content.title}
        aria-label="PRD title"
        disabled={prd.status !== 'draft'}
        oninput={(event) => {
          content = { ...content, title: event.currentTarget.value }
          dirty = true
        }}
      />
      <textarea
        class="mt-3 min-h-20 w-full resize-y rounded-lg bg-raised p-3 text-sm leading-6 text-muted outline-none focus:ring-1 focus:ring-thread-spec"
        value={content.summary}
        aria-label="PRD summary"
        disabled={prd.status !== 'draft'}
        oninput={(event) => {
          content = { ...content, summary: event.currentTarget.value }
          dirty = true
        }}></textarea>
      {#each content.sections as section (section.id)}
        <section class="mt-7">
          <h2 class="text-sm font-semibold text-foreground">{section.title}</h2>
          <textarea
            class="mt-2 min-h-28 w-full resize-y rounded-lg bg-raised p-3 text-sm leading-6 text-foreground outline-none focus:ring-1 focus:ring-thread-spec"
            value={section.markdown}
            aria-label={section.title}
            disabled={prd.status !== 'draft'}
            oninput={(event) => updateSection(section.id, event.currentTarget.value)}></textarea>
        </section>
      {/each}
      {#if error}<p class="mt-5 text-xs text-danger">{error}</p>{/if}
    </article>
  </main>
</div>
