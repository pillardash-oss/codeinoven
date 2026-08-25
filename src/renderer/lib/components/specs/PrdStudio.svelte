<script lang="ts">
  import {
    Check,
    ChevronDown,
    ExternalLink,
    FolderOpen,
    MessageSquarePlus,
    Save
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
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
    onAddAnnotation: (section: PrdSectionId, body: string) => void | Promise<void>
    onUpdateAnnotation: (annotationId: string, body: string) => void | Promise<void>
    onResolveAnnotation: (annotationId: string) => void | Promise<void>
    onFinalize: () => void | Promise<void>
    onNextStep?: () => void | Promise<void>
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
    onAddAnnotation,
    onUpdateAnnotation,
    onResolveAnnotation,
    onFinalize,
    onNextStep,
    onOpenInEditor,
    onRevealInFiles
  }: Props = $props()

  // The parent keys this component by PRD identity and version.
  // svelte-ignore state_referenced_locally
  let content = $state<PrdContent>(structuredClone(prd.content))
  let dirty = $state(false)
  let annotationDrafts = $state<Partial<Record<PrdSectionId, string>>>({})
  let nextStepBusy = $state(false)

  function updateSection(id: PrdSectionId, markdown: string): void {
    content = {
      ...content,
      sections: content.sections.map((section) =>
        section.id === id ? { ...section, markdown } : section
      )
    }
    dirty = true
  }

  function annotationsForSection(section: PrdSectionId) {
    return prd.annotations.filter((annotation) => annotation.section === section)
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
      {#if onNextStep}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy || nextStepBusy}
            title="Choose what to build next from this PRD"
          >
            {nextStepBusy ? 'Working…' : 'Next step'}
            <ChevronDown size={13} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
              strategy="fixed"
              class="z-50 w-52 rounded-lg border border-border bg-surface p-1 shadow-lg"
            >
              <DropdownMenu.Item
                class="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-elevated"
                title="Generate an implementation-ready Spec from this PRD"
                disabled={nextStepBusy}
                onSelect={() => {
                  if (!onNextStep || nextStepBusy) return
                  nextStepBusy = true
                  dirty = false
                  void Promise.resolve(onNextStep()).finally(() => {
                    nextStepBusy = false
                  })
                }}
              >
                <span>Generate Spec</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      {/if}
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
          {#if annotationsForSection(section.id).length > 0}
            <div class="mt-2 space-y-2" aria-label={`${section.title} comments`}>
              {#each annotationsForSection(section.id) as annotation (annotation.id)}
                <div class="rounded-lg border bg-raised p-2.5">
                  <textarea
                    class="min-h-16 w-full resize-y bg-transparent text-xs leading-5 text-foreground outline-none disabled:text-muted"
                    value={annotation.body}
                    aria-label={`Comment on ${section.title}`}
                    disabled={busy || prd.status !== 'draft' || annotation.status === 'resolved'}
                    onblur={(event) => {
                      const body = event.currentTarget.value.trim()
                      if (body && body !== annotation.body) {
                        void onUpdateAnnotation(annotation.id, body)
                      }
                    }}></textarea>
                  <div class="mt-1 flex items-center justify-between gap-2">
                    <span class="text-xs text-dimmed">{annotation.status}</span>
                    {#if annotation.status === 'open' && prd.status === 'draft'}
                      <button
                        type="button"
                        class="rounded-lg px-2 py-1 text-xs text-muted hover:bg-overlay hover:text-foreground disabled:opacity-50"
                        disabled={busy}
                        onclick={() => void onResolveAnnotation(annotation.id)}>Resolve</button
                      >
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          {#if prd.status === 'draft'}
            <div class="mt-2 flex items-start gap-2">
              <textarea
                class="min-h-16 flex-1 resize-y rounded-lg border bg-surface p-2.5 text-xs leading-5 text-foreground outline-none focus:ring-1 focus:ring-thread-spec"
                value={annotationDrafts[section.id] ?? ''}
                aria-label={`Add comment to ${section.title}`}
                placeholder="Add review comment"
                disabled={busy}
                oninput={(event) => {
                  annotationDrafts = {
                    ...annotationDrafts,
                    [section.id]: event.currentTarget.value
                  }
                }}></textarea>
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg border text-muted hover:bg-elevated hover:text-foreground disabled:opacity-50"
                title={`Add comment to ${section.title}`}
                aria-label={`Add comment to ${section.title}`}
                disabled={busy || !(annotationDrafts[section.id] ?? '').trim()}
                onclick={() => {
                  const body = (annotationDrafts[section.id] ?? '').trim()
                  if (!body) return
                  void onAddAnnotation(section.id, body)
                  annotationDrafts = { ...annotationDrafts, [section.id]: '' }
                }}
              >
                <MessageSquarePlus size={14} />
              </button>
            </div>
          {/if}
        </section>
      {/each}
      {#if error}<p class="mt-5 text-xs text-danger">{error}</p>{/if}
    </article>
  </main>
</div>
