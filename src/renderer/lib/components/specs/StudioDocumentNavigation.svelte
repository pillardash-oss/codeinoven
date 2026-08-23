<script lang="ts">
  import { ArrowLeft, MessageSquareText, PanelLeft } from '@lucide/svelte'

  type StudioDocument = 'brainstorm' | 'prd' | 'spec' | 'assignment' | 'audit'

  interface Props {
    active: StudioDocument
    brainstormAvailable?: boolean
    prdAvailable?: boolean
    specAvailable?: boolean
    assignmentAvailable?: boolean
    auditAvailable?: boolean
    agentMessagesOpen?: boolean
    /** Whether the studio's section rail is currently showing. */
    sectionsOpen?: boolean
    /** The section rail this label belongs to, for the toggle's accessible name. */
    sectionsLabel?: string
    onBack: () => void
    onToggleAgentMessages: () => void
    onToggleSections?: () => void
    onOpenBrainstorm?: () => void
    onOpenPrd?: () => void
    onOpenSpec?: () => void
    onOpenAssignment?: () => void
    onOpenAudit?: () => void
  }

  let {
    active,
    brainstormAvailable = false,
    prdAvailable = false,
    specAvailable = true,
    assignmentAvailable = false,
    auditAvailable = false,
    agentMessagesOpen = false,
    sectionsOpen = false,
    sectionsLabel = 'sections',
    onBack,
    onToggleAgentMessages,
    onToggleSections,
    onOpenBrainstorm,
    onOpenPrd,
    onOpenSpec,
    onOpenAssignment,
    onOpenAudit
  }: Props = $props()
</script>

<div class="flex min-w-0 items-center gap-2">
  <button
    class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted max-md:h-9 max-md:w-9 max-md:justify-center max-md:px-0 hover:bg-elevated hover:text-foreground"
    title="Back to the conversation"
    aria-label="Back to the conversation"
    onclick={onBack}
  >
    <ArrowLeft size={13} class="shrink-0" />
    <span class="max-md:hidden">Conversation</span>
  </button>
  <!-- Show/hide the studio's own section rail. On a phone it stands in for the
       agent-messages button below, whose rail lives in the desktop sidebar that
       the remote shell never mounts. -->
  {#if onToggleSections}
    <button
      class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md md:hidden {sectionsOpen
        ? 'bg-elevated text-foreground'
        : 'text-muted hover:bg-elevated hover:text-foreground'}"
      aria-pressed={sectionsOpen}
      aria-label={sectionsOpen ? `Hide ${sectionsLabel}` : `Show ${sectionsLabel}`}
      title={sectionsOpen ? `Hide ${sectionsLabel}` : `Show ${sectionsLabel}`}
      onclick={onToggleSections}
    >
      <PanelLeft size={13} />
    </button>
  {/if}
  <button
    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md max-md:hidden {agentMessagesOpen
      ? 'bg-elevated text-foreground'
      : 'text-muted hover:bg-elevated hover:text-foreground'}"
    aria-pressed={agentMessagesOpen}
    aria-label="Show agent messages"
    title="Show agent messages"
    onclick={onToggleAgentMessages}
  >
    <MessageSquareText size={13} />
  </button>
  <div class="flex min-w-0 overflow-x-auto rounded-lg bg-raised p-0.5" aria-label="Studio document">
    {#if brainstormAvailable && onOpenBrainstorm}
      <button
        class="shrink-0 rounded-md px-2 py-1 text-xs max-md:px-3 max-md:py-2 {active ===
        'brainstorm'
          ? 'bg-surface font-semibold text-foreground shadow-sm'
          : 'text-muted hover:bg-overlay hover:text-foreground'}"
        aria-pressed={active === 'brainstorm'}
        onclick={onOpenBrainstorm}
      >
        Brainstorm
      </button>
    {/if}
    {#if prdAvailable && onOpenPrd}
      <button
        class="shrink-0 rounded-md px-2 py-1 text-xs max-md:px-3 max-md:py-2 {active === 'prd'
          ? 'bg-surface font-semibold text-foreground shadow-sm'
          : 'text-muted hover:bg-overlay hover:text-foreground'}"
        aria-pressed={active === 'prd'}
        onclick={onOpenPrd}
      >
        PRD
      </button>
    {/if}
    <button
      class="shrink-0 rounded-md px-2 py-1 text-xs max-md:px-3 max-md:py-2 {active === 'spec'
        ? 'bg-surface font-semibold text-foreground shadow-sm'
        : specAvailable
          ? 'text-muted hover:bg-overlay hover:text-foreground'
          : 'cursor-not-allowed text-dimmed opacity-50'}"
      aria-pressed={active === 'spec'}
      aria-disabled={!specAvailable}
      disabled={!specAvailable}
      title={specAvailable
        ? 'Open specification'
        : 'Finalize the brainstorm to create a specification'}
      onclick={onOpenSpec}
    >
      Spec
    </button>
    {#if assignmentAvailable && onOpenAssignment}
      <button
        class="shrink-0 rounded-md px-2 py-1 text-xs max-md:px-3 max-md:py-2 {active ===
        'assignment'
          ? 'bg-surface font-semibold text-foreground shadow-sm'
          : 'text-muted hover:bg-overlay hover:text-foreground'}"
        aria-pressed={active === 'assignment'}
        onclick={onOpenAssignment}
      >
        Assignment
      </button>
    {/if}
    {#if auditAvailable && onOpenAudit}
      <button
        class="shrink-0 rounded-md px-2 py-1 text-xs max-md:px-3 max-md:py-2 {active === 'audit'
          ? 'bg-surface font-semibold text-foreground shadow-sm'
          : 'text-muted hover:bg-overlay hover:text-foreground'}"
        aria-pressed={active === 'audit'}
        onclick={onOpenAudit}
      >
        Audit
      </button>
    {/if}
  </div>
</div>
