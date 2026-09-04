<script lang="ts">
  import { Check, ChevronDown, MessageSquarePlus } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { tick } from 'svelte'
  import StudioDocumentNavigation from './StudioDocumentNavigation.svelte'
  import StudioShell from './StudioShell.svelte'
  import type { StudioShellSection } from './StudioShell.svelte'
  import StudioSidebarFileActions from './StudioSidebarFileActions.svelte'
  import StudioVersionBar from './StudioVersionBar.svelte'
  import StudioAnnotationDetailPopover from './StudioAnnotationDetailPopover.svelte'
  import type { PrdAnnotation, PrdContent, PrdDocument, PrdSectionId } from '$shared/types'

  type PrdNavigationSectionId = PrdSectionId | 'summary'

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
  let selectedSection = $state<PrdNavigationSectionId>('summary')
  let sectionsOpen = $state(false)
  let documentScroller = $state<HTMLElement | null>(null)
  let editingAnnotation = $state<PrdAnnotation | null>(null)
  let editingAnnotationBody = $state('')
  let editingAnnotationPosition = $state<{ x: number; y: number } | null>(null)
  let annotationEditMode = $state(false)

  const canEdit = $derived(prd.status === 'draft')

  const shellSections = $derived<StudioShellSection<PrdNavigationSectionId>[]>([
    { id: 'summary', title: 'Summary' },
    ...content.sections.map((section) => {
      const commentCount = annotationsForSection(section.id).length
      return {
        id: section.id,
        title: section.title,
        badges: commentCount
          ? [{ count: commentCount, tone: 'info' as const, label: 'comments' }]
          : undefined
      }
    })
  ])

  const openAnnotationCount = $derived(
    prd.annotations.filter((annotation) => annotation.status === 'open').length
  )

  function statusLabel(): string {
    return prd.status === 'draft'
      ? 'Draft'
      : prd.status === 'finalized'
        ? 'Finalized'
        : 'Superseded'
  }

  function statusClass(): string {
    if (prd.status === 'finalized') return 'bg-success/10 text-success'
    if (prd.status === 'superseded') return 'bg-raised text-dimmed'
    return 'bg-warning/10 text-warning'
  }

  function updateSection(id: PrdSectionId, markdown: string): void {
    content = {
      ...content,
      sections: content.sections.map((section) =>
        section.id === id ? { ...section, markdown } : section
      )
    }
    dirty = true
  }

  function annotationsForSection(section: PrdNavigationSectionId): PrdAnnotation[] {
    if (section === 'summary') return []
    return prd.annotations.filter((annotation) => annotation.section === section)
  }

  async function openAnnotation(annotation: PrdAnnotation): Promise<void> {
    selectedSection = annotation.section
    editingAnnotation = annotation
    editingAnnotationBody = annotation.body
    await tick()
    const sectionElement = document.querySelector<HTMLElement>(
      `[data-prd-section="${annotation.section}"]`
    )
    editingAnnotationPosition = sectionElement
      ? {
          x: Math.max(
            12,
            Math.min(sectionElement.getBoundingClientRect().right + 8, window.innerWidth - 332)
          ),
          y: Math.max(
            12,
            Math.min(sectionElement.getBoundingClientRect().top, window.innerHeight - 288)
          )
        }
      : { x: 12, y: 12 }
  }

  function closeAnnotation(): void {
    editingAnnotation = null
    editingAnnotationBody = ''
    editingAnnotationPosition = null
    annotationEditMode = false
  }

  async function saveAnnotationEdit(): Promise<void> {
    const annotation = editingAnnotation
    const body = editingAnnotationBody.trim()
    if (!annotation || !body) return
    await onUpdateAnnotation(annotation.id, body)
    closeAnnotation()
  }

  function editAnnotation(): void {
    annotationEditMode = true
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    const saveShortcut =
      event.key.toLowerCase() === 's' &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    if (!saveShortcut || event.repeat || event.isComposing) return
    event.preventDefault()
    save()
  }

  function save(): void {
    if (!dirty || busy || !canEdit) return
    void onSave(content)
    dirty = false
  }
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<StudioShell
  ariaLabel="PRD studio"
  scrollerLabel="PRD document"
  sidebarTitle="PRD"
  sidebarLabel="PRD sections"
  sectionAnchorPrefix="prd-section"
  sections={shellSections}
  bind:selectedSection
  bind:sectionsOpen
  bind:scroller={documentScroller}
  {openAnnotationCount}
  annotationsTitle="Comments"
  annotationsEmptyLabel={canEdit ? 'Add a review comment below a section.' : 'No open comments.'}
  sectionAnnotations={annotationsForSection}
  onOpenAnnotation={(annotation) => void openAnnotation(annotation)}
  {error}
>
  {#snippet navigation()}
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
      {sectionsOpen}
      sectionsLabel="PRD sections"
      onToggleSections={() => (sectionsOpen = !sectionsOpen)}
      {onOpenBrainstorm}
      {onOpenSpec}
      {onOpenAssignment}
      {onOpenAudit}
    />
  {/snippet}

  {#snippet center()}
    <StudioVersionBar
      versions={versions.map((version) => ({
        version: version.version,
        status: version.status
      }))}
      currentVersion={prd.version}
      updatedAt={prd.updatedAt}
      statusLabel={statusLabel()}
      statusClass={statusClass()}
      {dirty}
      canUndo={false}
      canRedo={false}
      canSave={canEdit}
      {busy}
      savePending={false}
      versionMenuTitle="Choose a PRD version"
      versionItemTitle={(version) => `Open PRD version ${version}`}
      onSelectVersion={onSelectVersion}
      onUndo={() => undefined}
      onRedo={() => undefined}
      onSave={save}
    />
  {/snippet}

  {#snippet actions()}
    {#if canEdit}
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg bg-thread-spec px-2.5 text-xs font-medium text-foreground disabled:opacity-50"
        disabled={busy}
        title="Finalize this PRD"
        onclick={() => void onFinalize()}
      >
        <Check size={13} /> Finalize
      </button>
    {/if}
    {#if onNextStep && canEdit}
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
              class="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-elevated"
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
  {/snippet}

  {#snippet sidebarFooter()}
    <StudioSidebarFileActions
      viewTitle="Reveal this PRD as Markdown in the file tree"
      openTitle="Open this PRD in the system editor"
      {busy}
      onReveal={onRevealInFiles ? () => onRevealInFiles() : undefined}
      onOpen={onOpenInEditor ? () => onOpenInEditor() : undefined}
    />
  {/snippet}

  <article class="rounded-2xl border bg-surface p-6 shadow-sm">
    <section id="prd-section-summary" data-prd-section="summary" class="scroll-mt-5">
      <input
        class="w-full bg-transparent text-2xl font-semibold text-foreground outline-none"
        value={content.title}
        aria-label="PRD title"
        disabled={!canEdit}
        oninput={(event) => {
          content = { ...content, title: event.currentTarget.value }
          dirty = true
        }}
      />
      <textarea
        class="mt-3 min-h-20 w-full resize-y rounded-lg bg-raised p-3 text-sm leading-6 text-muted outline-none focus:ring-1 focus:ring-thread-spec"
        value={content.summary}
        aria-label="PRD summary"
        disabled={!canEdit}
        oninput={(event) => {
          content = { ...content, summary: event.currentTarget.value }
          dirty = true
        
        }}></textarea>
    </section>
    {#each content.sections as section (section.id)}
      <section
        id={`prd-section-${section.id}`}
        data-prd-section={section.id}
        class="mt-7 scroll-mt-5"
      >
        <h2 class="text-sm font-semibold text-foreground">{section.title}</h2>
        <textarea
          class="mt-2 min-h-28 w-full resize-y rounded-lg bg-raised p-3 text-sm leading-6 text-foreground outline-none focus:ring-1 focus:ring-thread-spec"
          value={section.markdown}
          aria-label={section.title}
          disabled={!canEdit}
          oninput={(event) => updateSection(section.id, event.currentTarget.value)}></textarea>
        {#if annotationsForSection(section.id).length > 0}
          <div class="mt-2 flex gap-2 overflow-x-auto pb-1" aria-label={`${section.title} comments`}>
            {#each annotationsForSection(section.id) as annotation (annotation.id)}
              <button
                class="max-w-64 shrink-0 rounded-xl border bg-elevated px-3 py-2 text-left hover:bg-overlay"
                title="Open comment"
                onclick={() => void openAnnotation(annotation)}
              >
                <span class="line-clamp-2 text-xs leading-relaxed">{annotation.body}</span>
                <span class="mt-1 block text-[0.625rem] text-dimmed">
                  {annotation.status === 'open' ? annotation.author : annotation.status}
                </span>
              </button>
            {/each}
          </div>
        {/if}
        {#if canEdit}
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
  </article>
</StudioShell>

{#if editingAnnotation && editingAnnotationPosition}
  <StudioAnnotationDetailPopover
    position={editingAnnotationPosition}
    annotation={editingAnnotation}
    canEdit={canEdit && !busy && editingAnnotation?.status === 'open'}
    editorMode={annotationEditMode}
    headerLabel={annotationEditMode ? 'Edit comment' : 'Comment'}
    dialogLabel="PRD comment"
    speechTargetId={`prd-annotation-edit-${editingAnnotation.id}`}
    scope={{ kind: 'project', projectId: prd.projectId, threadId: prd.threadId }}
    bind:body={editingAnnotationBody}
    onResolve={() => {
      if (editingAnnotation) void onResolveAnnotation(editingAnnotation.id)
      closeAnnotation()
    }}
    onSave={saveAnnotationEdit}
    onCancelEdit={() => (annotationEditMode = false)}
    onEditClick={editAnnotation}
    onClose={closeAnnotation}
  />
{/if}
