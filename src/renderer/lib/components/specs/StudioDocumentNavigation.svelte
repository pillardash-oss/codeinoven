<script lang="ts">
  import { ArrowLeft, MessageSquareText } from '@lucide/svelte'

  type StudioDocument = 'brainstorm' | 'spec' | 'assignment' | 'audit'

  interface Props {
    active: StudioDocument
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
  }

  let {
    active,
    brainstormAvailable = false,
    specAvailable = true,
    assignmentAvailable = false,
    auditAvailable = false,
    agentMessagesOpen = false,
    onBack,
    onToggleAgentMessages,
    onOpenBrainstorm,
    onOpenSpec,
    onOpenAssignment,
    onOpenAudit
  }: Props = $props()
</script>

<div class="flex min-w-0 items-center gap-2">
  <button
    class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-elevated hover:text-foreground"
    title="Back to the conversation"
    onclick={onBack}
  >
    <ArrowLeft size={13} />
    Conversation
  </button>
  <button
    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md {agentMessagesOpen
      ? 'bg-elevated text-foreground'
      : 'text-muted hover:bg-elevated hover:text-foreground'}"
    aria-pressed={agentMessagesOpen}
    aria-label="Show agent messages"
    title="Show agent messages"
    onclick={onToggleAgentMessages}
  >
    <MessageSquareText size={13} />
  </button>
  <div class="flex rounded-lg bg-raised p-0.5" aria-label="Studio document">
    {#if brainstormAvailable && onOpenBrainstorm}
      <button
        class="rounded-md px-2 py-1 text-xs {active === 'brainstorm'
          ? 'bg-surface font-semibold text-foreground shadow-sm'
          : 'text-muted hover:bg-overlay hover:text-foreground'}"
        aria-pressed={active === 'brainstorm'}
        onclick={onOpenBrainstorm}
      >
        Brainstorm
      </button>
    {/if}
    <button
      class="rounded-md px-2 py-1 text-xs {active === 'spec'
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
        class="rounded-md px-2 py-1 text-xs {active === 'assignment'
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
        class="rounded-md px-2 py-1 text-xs {active === 'audit'
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
