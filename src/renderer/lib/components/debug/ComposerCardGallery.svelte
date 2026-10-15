<script lang="ts">
  import { Send, TriangleAlert } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { DEFAULT_SETTINGS } from '$lib/stores/thread-settings.svelte'
  import AgentProviderStatusCard from '../threads/AgentProviderStatusCard.svelte'
  import AgentQuestionCard from '../threads/AgentQuestionCard.svelte'
  import AgentSecretCard from '../threads/AgentSecretCard.svelte'
  import AgentTodoCard from '../threads/AgentTodoCard.svelte'
  import AiAccountSetupCard from '../threads/AiAccountSetupCard.svelte'
  import AssignmentReadyCard from '../threads/AssignmentReadyCard.svelte'
  import AuditGeneratedCard from '../threads/AuditGeneratedCard.svelte'
  import AuditOfferCard from '../threads/AuditOfferCard.svelte'
  import AuditReadyCard from '../threads/AuditReadyCard.svelte'
  import BrainstormEntryChoiceCard from '../threads/BrainstormEntryChoiceCard.svelte'
  import BrainstormReadyCard from '../threads/BrainstormReadyCard.svelte'
  import ComposerQueuedCard from '../threads/ComposerQueuedCard.svelte'
  import EngineeringRetryCard from '../threads/EngineeringRetryCard.svelte'
  import ForeignRunCard from '../threads/ForeignRunCard.svelte'
  import ImageDescriptorErrorCard from '../threads/ImageDescriptorErrorCard.svelte'
  import PermissionRequestCard from '../threads/PermissionRequestCard.svelte'
  import PrdReadyCard from '../threads/PrdReadyCard.svelte'
  import RunChangesCard from '../threads/RunChangesCard.svelte'
  import SpecReadyCard from '../threads/SpecReadyCard.svelte'
  import SubagentCard from '../threads/SubagentCard.svelte'
  import RoutineRecapCard from '../assistant/RoutineRecapCard.svelte'
  import ChatComposerImageGate from '../chats/ChatComposerImageGate.svelte'
  import EngineeringEntryCard from '../chats/EngineeringEntryCard.svelte'
  import ExpertCard from '../chats/ExpertCard.svelte'
  import ProjectFileMentionMenu from '../chats/ProjectFileMentionMenu.svelte'
  import SlashActionMenu from '../actions/SlashActionMenu.svelte'
  import CardNotice from '../shared/CardNotice.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import {
    galleryAssignment,
    galleryAuditReport,
    galleryCheckpoint,
    galleryCheckpointUndone,
    galleryExpertState,
    galleryImageDescriptorError,
    galleryMentionEntries,
    galleryPermission,
    galleryQuestionFile,
    galleryQuestionMultiple,
    galleryQuestionPlain,
    galleryQuestionSingle,
    galleryQuestionWalkthrough,
    galleryScope,
    gallerySecret,
    gallerySlashActions,
    galleryStartAfterThreads,
    gallerySubagentPart,
    galleryTodoItems
  } from './composer-card-fixtures'

  interface Props {
    open: boolean
    onClose: () => void
  }

  let { open, onClose }: Props = $props()

  type GalleryGroup = 'replace' | 'above' | 'inside' | 'top'

  interface GalleryEntry {
    id: string
    group: GalleryGroup
    label: string
    /** What this state is for, shown under the stage. */
    note: string
  }

  const GROUPS: { id: GalleryGroup; label: string; blurb: string }[] = [
    { id: 'replace', label: 'Replace the composer', blurb: 'One at a time; the first match wins.' },
    { id: 'above', label: 'Above the composer', blurb: 'Stacks on the composer edge.' },
    { id: 'inside', label: 'Inside the composer', blurb: 'Gates, notices and menus.' },
    { id: 'top', label: 'Top of the thread', blurb: 'Report only; never blocks.' }
  ]

  const ENTRIES: GalleryEntry[] = [
    {
      id: 'permission',
      group: 'replace',
      label: 'Permission request',
      note: 'High risk, patterns, an expiry.'
    },
    {
      id: 'question-single',
      group: 'replace',
      label: 'Question, single choice',
      note: 'Rich options, a recommendation, a countdown.'
    },
    {
      id: 'question-multiple',
      group: 'replace',
      label: 'Question, multi choice',
      note: 'Several answers, no countdown.'
    },
    {
      id: 'question-plain',
      group: 'replace',
      label: 'Question, plain options',
      note: 'Short answers, no descriptions.'
    },
    {
      id: 'question-file',
      group: 'replace',
      label: 'Question, file request',
      note: 'Paths as options and a drop target.'
    },
    {
      id: 'question-walkthrough',
      group: 'replace',
      label: 'Question, walkthrough',
      note: 'Three questions, the middle one open.'
    },
    { id: 'secret', group: 'replace', label: 'Secret request', note: 'Two secrets, value mode.' },
    {
      id: 'audit-running',
      group: 'replace',
      label: 'Audit running',
      note: 'With a real start time, so the chip counts.'
    },
    { id: 'audit-failed', group: 'replace', label: 'Audit failed', note: 'Stopped, with a retry.' },
    {
      id: 'audit-partial',
      group: 'replace',
      label: 'Audit partial',
      note: 'Usable report, facts unproven.'
    },
    {
      id: 'audit-offer',
      group: 'replace',
      label: 'Audit offer',
      note: 'The assignment is complete.'
    },
    {
      id: 'audit-ready',
      group: 'replace',
      label: 'Audit report ready',
      note: 'One open annotation, so Complete hides.'
    },
    { id: 'prd-ready', group: 'replace', label: 'PRD ready', note: 'Draft waiting for review.' },
    {
      id: 'brainstorm-choice',
      group: 'replace',
      label: 'Choose how to start',
      note: 'Two paths, one recommended.'
    },
    {
      id: 'brainstorm-retry',
      group: 'replace',
      label: 'Retry brainstorm',
      note: 'The choice failed; retry it.'
    },
    {
      id: 'brainstorm-ready',
      group: 'replace',
      label: 'Brainstorm ready',
      note: 'Report ready, next step menu.'
    },
    {
      id: 'assignment-ready',
      group: 'replace',
      label: 'Assignment ready',
      note: 'Four tasks drafted, nothing runs yet.'
    },
    {
      id: 'spec-ready',
      group: 'replace',
      label: 'Specification ready',
      note: 'Review or implement.'
    },
    {
      id: 'assignment-entry',
      group: 'replace',
      label: 'Assignment entry',
      note: 'A conversation-level assignment.'
    },
    {
      id: 'engineering-retry',
      group: 'replace',
      label: 'Engineering stage failed',
      note: 'Retry the stage on another model.'
    },
    {
      id: 'engineering-entry',
      group: 'replace',
      label: 'Start an engineering flow',
      note: 'PRD or spec first.'
    },
    {
      id: 'ai-account',
      group: 'replace',
      label: 'Connect your AI account',
      note: 'Nothing signed in for this harness.'
    },
    {
      id: 'foreign-run',
      group: 'replace',
      label: 'Running on another instance',
      note: 'The thread is live elsewhere.'
    },
    {
      id: 'vision-failure',
      group: 'replace',
      label: 'Image Descriptor failed',
      note: 'Retry, replace or continue.'
    },
    {
      id: 'routine-recap',
      group: 'replace',
      label: 'Routine recap',
      note: 'The agent drafted a routine.'
    },
    {
      id: 'todo-running',
      group: 'above',
      label: 'Tasks, running',
      note: 'The current item is marked.'
    },
    {
      id: 'todo-stopped',
      group: 'above',
      label: 'Tasks, stopped early',
      note: 'Amber edge and the unfinished notice.'
    },
    {
      id: 'queued-one',
      group: 'above',
      label: 'Queued message',
      note: 'One message behind the turn.'
    },
    {
      id: 'queued-many',
      group: 'above',
      label: 'Queued with next up',
      note: 'A FIFO queue with a count.'
    },
    {
      id: 'starts-after',
      group: 'above',
      label: 'Starts after',
      note: 'The message waits on two threads.'
    },
    {
      id: 'vision-gate',
      group: 'inside',
      label: 'Vision gate',
      note: 'The model cannot see images.'
    },
    {
      id: 'expert-gate',
      group: 'inside',
      label: 'Expert gate',
      note: 'Staffed experts can take this.'
    },
    {
      id: 'oven-notice',
      group: 'inside',
      label: 'Oven model notice',
      note: 'The oven is not running this model.'
    },
    {
      id: 'attachment-blocked',
      group: 'inside',
      label: 'Attachments blocked',
      note: 'The harness takes no files.'
    },
    {
      id: 'text-too-large',
      group: 'inside',
      label: 'Text attachment too large',
      note: 'A single file is over the limit.'
    },
    {
      id: 'slash-menu',
      group: 'inside',
      label: 'Slash menu',
      note: 'Grouped actions, one disabled.'
    },
    {
      id: 'mention-menu',
      group: 'inside',
      label: 'Mention menu',
      note: 'Files, an ignored one, filters.'
    },
    {
      id: 'provider-waiting',
      group: 'top',
      label: 'Provider waiting',
      note: 'Rate limited, retrying.'
    },
    { id: 'provider-error', group: 'top', label: 'Provider error', note: 'The request failed.' },
    {
      id: 'subagent',
      group: 'top',
      label: 'Sub-agent working',
      note: 'Live, with a real elapsed time.'
    },
    {
      id: 'compaction',
      group: 'top',
      label: 'Compaction interrupted',
      note: 'The summary was never saved.'
    },
    {
      id: 'run-changes',
      group: 'top',
      label: 'Edited files',
      note: 'A turn checkpoint, five files.'
    },
    {
      id: 'run-changes-undone',
      group: 'top',
      label: 'Edited files, undone',
      note: 'The same checkpoint rolled back.'
    }
  ]

  let selectedId = $state('permission')
  const selected = $derived(ENTRIES.find((entry) => entry.id === selectedId) ?? ENTRIES[0])
  // The same source the thread view hands its cards, so the pickers in the
  // gallery behave exactly as they do in the app.
  const providers = $derived(providerCatalog.allCached())
  const entriesForGroup = $derived(ENTRIES.filter((entry) => entry.group === selected.group))

  function pick(entry: GalleryEntry): void {
    selectedId = entry.id
  }

  function pickGroup(group: GalleryGroup): void {
    const first = ENTRIES.find((entry) => entry.group === group)
    if (first) pick(first)
  }

  // Every action in the gallery is inert: the point is to look at the card, not
  // to run it. The promises some cards await still resolve, so a card that shows
  // a pending state returns to rest.
  /** The assignment's model pair, in the full shape the card selects with. */
  const galleryModel = {
    harnessId: DEFAULT_SETTINGS.harnessId,
    providerId: DEFAULT_SETTINGS.providerId,
    modelId: DEFAULT_SETTINGS.modelId,
    thinkingLevel: DEFAULT_SETTINGS.thinkingLevel
  }

  const noop = (): void => {}
  const noopAsync = async (): Promise<void> => {}
  const noopUpdate = async (): Promise<null> => null
</script>

<Modal {open} {onClose} title="Composer cards" placement="fullscreen">
  <div class="flex min-h-0 flex-1">
    <aside class="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border bg-app">
      <div class="border-b border-border px-3 py-3">
        <p class="text-[0.6875rem] font-semibold tracking-[0.06em] uppercase text-dimmed">
          Developer tool
        </p>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          Every card the chat composer can show, in the state it is written for. Pick one and look
          at it; nothing here runs.
        </p>
      </div>
      {#each GROUPS as group (group.id)}
        <div class="border-b border-border py-2">
          <button
            type="button"
            class="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[0.6875rem] font-semibold tracking-[0.06em] uppercase transition-colors {selected.group ===
            group.id
              ? 'text-foreground'
              : 'text-dimmed hover:text-foreground'}"
            title={group.blurb}
            onclick={() => pickGroup(group.id)}
          >
            {group.label}
            <span class="tabular-nums"
              >{ENTRIES.filter((entry) => entry.group === group.id).length}</span
            >
          </button>
          <ul>
            {#each entriesForGroup as entry (entry.id)}
              <li>
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors {entry.id ===
                  selectedId
                    ? 'bg-overlay text-foreground'
                    : 'text-muted hover:bg-elevated hover:text-foreground'}"
                  aria-current={entry.id === selectedId}
                  title={entry.note}
                  onclick={() => pick(entry)}
                >
                  {entry.label}
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    </aside>

    <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-surface">
      <header class="flex items-center gap-3 border-b border-border px-4 py-3">
        <div class="min-w-0">
          <p class="text-[0.8125rem] font-semibold text-foreground">{selected.label}</p>
          <p class="mt-0.5 text-[0.6875rem] text-muted">{selected.note}</p>
        </div>
        <span
          class="ml-auto shrink-0 border border-border px-1.5 py-0.5 text-[0.625rem] font-semibold tracking-[0.06em] uppercase text-dimmed"
          >{selected.group}</span
        >
      </header>

      <div class="min-h-0 flex-1 px-6 py-6">
        <div class="mx-auto w-full max-w-3xl">
          {#if selected.id === 'permission'}
            <PermissionRequestCard
              request={galleryPermission}
              scope={galleryScope}
              onAllowOnce={noopAsync}
              onAllowAlways={noopAsync}
              onReject={noopAsync}
              onAlternative={noopAsync}
            />
          {:else if selected.id === 'question-single'}
            <AgentQuestionCard
              request={galleryQuestionSingle}
              scope={galleryScope}
              settings={DEFAULT_SETTINGS}
              {providers}
              onAnswer={noopAsync}
              onDismiss={noopAsync}
              onUpdate={noopUpdate}
              onExplain={noop}
              onQuickChat={noop}
            />
          {:else if selected.id === 'question-multiple'}
            <AgentQuestionCard
              request={galleryQuestionMultiple}
              scope={galleryScope}
              settings={DEFAULT_SETTINGS}
              {providers}
              onAnswer={noopAsync}
              onDismiss={noopAsync}
              onUpdate={noopUpdate}
              onExplain={noop}
              onQuickChat={noop}
            />
          {:else if selected.id === 'question-plain'}
            <AgentQuestionCard
              request={galleryQuestionPlain}
              scope={galleryScope}
              settings={DEFAULT_SETTINGS}
              {providers}
              onAnswer={noopAsync}
              onDismiss={noopAsync}
              onUpdate={noopUpdate}
            />
          {:else if selected.id === 'question-file'}
            <AgentQuestionCard
              request={galleryQuestionFile}
              scope={galleryScope}
              settings={DEFAULT_SETTINGS}
              {providers}
              onAnswer={noopAsync}
              onDismiss={noopAsync}
              onUpdate={noopUpdate}
            />
          {:else if selected.id === 'question-walkthrough'}
            <AgentQuestionCard
              request={galleryQuestionWalkthrough}
              scope={galleryScope}
              settings={DEFAULT_SETTINGS}
              {providers}
              onAnswer={noopAsync}
              onDismiss={noopAsync}
              onUpdate={noopUpdate}
              onExplain={noop}
              onQuickChat={noop}
            />
          {:else if selected.id === 'secret'}
            <AgentSecretCard
              request={gallerySecret}
              scope={galleryScope}
              onSubmit={noopAsync}
              onDismiss={noopAsync}
              onPause={noopAsync}
              onExplain={noop}
              onQuickChat={noop}
            />
          {:else if selected.id === 'audit-running'}
            <AuditGeneratedCard
              state="running"
              startedAt={Date.now() - 72_000}
              settings={DEFAULT_SETTINGS}
              {providers}
              onRetry={noop}
              onModelChange={noop}
              onViewReport={noop}
            />
          {:else if selected.id === 'audit-failed'}
            <AuditGeneratedCard
              state="failed"
              error="The auditor stopped before it wrote a report."
              settings={DEFAULT_SETTINGS}
              {providers}
              onRetry={noop}
              onModelChange={noop}
              onViewReport={noop}
            />
          {:else if selected.id === 'audit-partial'}
            <AuditGeneratedCard
              state="partial"
              validationIssues={['2 verification claims could not be matched to tool evidence.']}
              settings={DEFAULT_SETTINGS}
              {providers}
              retryLabel="Ask auditor to validate facts"
              onRetry={noop}
              onModelChange={noop}
              onViewReport={noop}
            />
          {:else if selected.id === 'audit-offer'}
            <AuditOfferCard
              threadTitle="Composer card design pass"
              settings={DEFAULT_SETTINGS}
              {providers}
              onCancel={noop}
              onAudit={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'audit-ready'}
            <AuditReadyCard
              report={galleryAuditReport}
              settings={DEFAULT_SETTINGS}
              {providers}
              onReview={noop}
              onViewReport={noop}
              onCancel={noop}
              onReaudit={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'prd-ready'}
            <PrdReadyCard
              settings={DEFAULT_SETTINGS}
              {providers}
              onReview={noop}
              onFinalize={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'brainstorm-choice'}
            <BrainstormEntryChoiceCard
              settings={DEFAULT_SETTINGS}
              {providers}
              onStartBrainstorm={noop}
              onJumpToSpec={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'brainstorm-retry'}
            <BrainstormEntryChoiceCard
              retryChoice="brainstorm"
              settings={DEFAULT_SETTINGS}
              {providers}
              onStartBrainstorm={noop}
              onJumpToSpec={noop}
              onModelChange={noop}
              onCancel={noop}
            />
          {:else if selected.id === 'brainstorm-ready'}
            <BrainstormReadyCard
              version={2}
              settings={DEFAULT_SETTINGS}
              {providers}
              onReview={noop}
              onNextStep={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'assignment-ready'}
            <AssignmentReadyCard
              assignment={galleryAssignment}
              {providers}
              harnessId={DEFAULT_SETTINGS.harnessId}
              fallbackModel={galleryModel}
              seniorModel={galleryModel}
              onSave={noop}
              onApprove={noop}
              onOpenFullscreen={noop}
            />
          {:else if selected.id === 'spec-ready'}
            <SpecReadyCard
              settings={DEFAULT_SETTINGS}
              {providers}
              onCancel={noop}
              onReview={noop}
              onProceed={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'assignment-entry'}
            <SpecReadyCard
              specless
              assignmentMode
              settings={DEFAULT_SETTINGS}
              {providers}
              onCancel={noop}
              onReview={noop}
              onProceed={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'engineering-retry'}
            <EngineeringRetryCard
              stage="spec"
              failure="The specification model returned an empty document."
              settings={DEFAULT_SETTINGS}
              {providers}
              onRetry={noop}
              onCancel={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'engineering-entry'}
            <EngineeringEntryCard
              target="spec"
              settings={DEFAULT_SETTINGS}
              {providers}
              onBrainstormFirst={noop}
              onJumpIn={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'ai-account'}
            <AiAccountSetupCard
              harnessName="Pi"
              {providers}
              settings={DEFAULT_SETTINGS}
              projectId="gallery-project"
              onModelChange={noop}
              onConnect={noop}
              onDismiss={noop}
            />
          {:else if selected.id === 'foreign-run'}
            <ForeignRunCard projectId="gallery-project" threadId="gallery-thread" />
          {:else if selected.id === 'vision-failure'}
            <ImageDescriptorErrorCard
              request={galleryImageDescriptorError}
              {providers}
              projectId="gallery-project"
              onRetry={noopAsync}
              onIgnore={noopAsync}
              onPickImage={noopAsync}
              onFalsePositive={noopAsync}
            />
          {:else if selected.id === 'routine-recap'}
            <RoutineRecapCard
              routineName="Morning inbox sweep"
              howTo="Read the inbox, tag anything urgent, and summarise the rest."
              plan={null}
              scheduled
              existingConnections={['Gmail', 'Slack']}
              saving={false}
              onSave={noop}
              onKeepEditing={noop}
            />
          {:else if selected.id === 'todo-running'}
            <AgentTodoCard
              items={galleryTodoItems}
              signature="gallery-running"
              busy
              stopped={false}
              onClose={noop}
            />
            {@render mockComposer(true)}
          {:else if selected.id === 'todo-stopped'}
            <AgentTodoCard
              items={galleryTodoItems}
              signature="gallery-stopped"
              busy={false}
              stopped
              onClose={noop}
            />
            {@render mockComposer(true)}
          {:else if selected.id === 'queued-one'}
            <ComposerQueuedCard
              text="Also check the staging deploy before merging."
              hasContent
              count={1}
              next={[]}
              promptReferences={[]}
              presentation={undefined}
              startAfterThreads={[]}
              steerModifierLabel="⌘⇧"
              onSteer={noop}
              onEdit={noop}
              onDelete={noop}
              onDeleteAll={noop}
              onAddStartAfter={noop}
              onRemoveStartAfter={noop}
              onOpenStartAfter={noop}
              onPreloadStartAfter={noop}
            />
            {@render mockComposer(true)}
          {:else if selected.id === 'queued-many'}
            <ComposerQueuedCard
              text="Also check the staging deploy before merging."
              hasContent
              count={3}
              next={[
                { id: 'next-1', text: 'Then update the changelog.' },
                { id: 'next-2', text: 'And ask the reviewer to look at the diff.' }
              ]}
              promptReferences={[]}
              presentation={undefined}
              startAfterThreads={[]}
              steerModifierLabel="⌘⇧"
              onSteer={noop}
              onEdit={noop}
              onDelete={noop}
              onDeleteAll={noop}
              onAddStartAfter={noop}
              onRemoveStartAfter={noop}
              onOpenStartAfter={noop}
              onPreloadStartAfter={noop}
            />
            {@render mockComposer(true)}
          {:else if selected.id === 'starts-after'}
            <ComposerQueuedCard
              text="Once those land, cut the release."
              hasContent
              count={1}
              next={[]}
              promptReferences={[]}
              presentation={undefined}
              startAfterThreads={galleryStartAfterThreads}
              steerModifierLabel="⌘⇧"
              onSteer={noop}
              onEdit={noop}
              onDelete={noop}
              onDeleteAll={noop}
              onAddStartAfter={noop}
              onRemoveStartAfter={noop}
              onOpenStartAfter={noop}
              onPreloadStartAfter={noop}
            />
            {@render mockComposer(true)}
          {:else if selected.id === 'vision-gate'}
            {@render mockComposer(true, true)}
          {:else if selected.id === 'expert-gate'}
            <div class="border border-border bg-surface">
              <ExpertCard
                expertState={galleryExpertState}
                session="design"
                modelLabel={() => 'deepseek-v4.1-flash'}
                onUse={noop}
                onDisable={noop}
                onNeverAsk={noop}
                onOpenSettings={noop}
              />
              {@render mockComposerBody()}
            </div>
          {:else if selected.id === 'oven-notice'}
            <div class="border border-border bg-surface">
              <CardNotice placement="composer" tone="warn">
                The selected oven is not running this model. Choose another model to send.
              </CardNotice>
              {@render mockComposerBody()}
            </div>
          {:else if selected.id === 'attachment-blocked'}
            <div class="border border-border bg-surface">
              <CardNotice placement="composer" tone="danger">
                This harness cannot take attachments. Remove them or switch harness.
              </CardNotice>
              {@render mockComposerBody()}
            </div>
          {:else if selected.id === 'text-too-large'}
            <div class="border border-border bg-surface">
              <CardNotice placement="composer" tone="danger">
                This text file is too large to attach.
              </CardNotice>
              {@render mockComposerBody()}
            </div>
          {:else if selected.id === 'slash-menu'}
            <div class="relative max-w-xl">
              <SlashActionMenu
                actions={gallerySlashActions}
                query=""
                activeIndex={0}
                onSelect={noop}
              />
              {@render mockComposer(false)}
            </div>
          {:else if selected.id === 'mention-menu'}
            <div class="relative max-w-xl">
              <ProjectFileMentionMenu
                entries={galleryMentionEntries}
                activeIndex={0}
                query="card"
                onSelect={noop}
                onFilterChange={noop}
              />
              {@render mockComposer(false)}
            </div>
          {:else if selected.id === 'provider-waiting'}
            <AgentProviderStatusCard
              status={{
                state: 'waiting',
                issue: {
                  kind: 'rate_limit',
                  message: 'The provider is rate limited; the thread resumes when it clears.',
                  harnessId: DEFAULT_SETTINGS.harnessId,
                  retryable: true,
                  retryAt: Date.now() + 20_000
                }
              }}
              providerName="OpenCode Go"
              settings={DEFAULT_SETTINGS}
              {providers}
              onRetry={noop}
              onStop={noop}
              onDismiss={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'provider-error'}
            <AgentProviderStatusCard
              status={{
                state: 'error',
                issue: {
                  kind: 'network',
                  message: 'The connection dropped mid-turn.',
                  harnessId: DEFAULT_SETTINGS.harnessId,
                  retryable: true
                }
              }}
              providerName="OpenCode Go"
              settings={DEFAULT_SETTINGS}
              {providers}
              onRetry={noop}
              onStop={noop}
              onDismiss={noop}
              onModelChange={noop}
            />
          {:else if selected.id === 'subagent'}
            <SubagentCard part={gallerySubagentPart} live onOpen={noop} />
          {:else if selected.id === 'compaction'}
            <CardFrame placement="top" label="Compaction interrupted">
              <CardHead
                icon={TriangleAlert}
                title="Compaction interrupted"
                chip={{ text: 'Stopped', tone: 'urgent' }}
                foldLabel="compaction notice"
              />
              <div class="space-y-2 px-3 py-2.5">
                <CardNotice tone="warn">
                  Compaction was interrupted before the summary was saved.
                </CardNotice>
              </div>
              <CardFoot>
                {#snippet left()}
                  <CardButton label="Dismiss" variant="ghost" onclick={noop} />
                {/snippet}
              </CardFoot>
            </CardFrame>
          {:else if selected.id === 'run-changes'}
            <RunChangesCard
              checkpoint={galleryCheckpoint}
              projectId="gallery-project"
              threadId="gallery-thread"
              onRevealFile={noop}
              onOpenFile={noop}
              onReview={noop}
              onUndo={noopAsync}
              onRedo={noopAsync}
            />
          {:else if selected.id === 'run-changes-undone'}
            <RunChangesCard
              checkpoint={galleryCheckpointUndone}
              projectId="gallery-project"
              threadId="gallery-thread"
              onRevealFile={noop}
              onOpenFile={noop}
              onReview={noop}
              onUndo={noopAsync}
              onRedo={noopAsync}
            />
          {/if}
        </div>
      </div>
    </section>
  </div>
</Modal>

{#snippet mockComposerBody()}
  <p class="px-3 py-2.5 text-[0.8125rem] text-dimmed">Send a message...</p>
  <div class="flex items-center gap-2 border-t border-dashed border-border-strong px-3 py-2">
    <span class="text-[0.6875rem] text-dimmed">Message</span>
    <span class="ml-auto"
      ><CardButton label="Send" variant="primary" icon={Send} onclick={noop} /></span
    >
  </div>
{/snippet}

<!-- The composer stand-in the cards sit against, so the join a stack makes with
the composer edge is visible while its design is reviewed. -->
{#snippet mockComposer(joined: boolean, gate = false)}
  <div class="border border-border bg-surface {joined ? '[border-top-style:dashed]' : ''}">
    {#if gate}
      <ChatComposerImageGate
        {providers}
        projectId="gallery-project"
        harnessId={DEFAULT_SETTINGS.harnessId}
        visionSelection={null}
        donotAsk={false}
        onCancel={noop}
        onConfirm={noop}
      />
    {/if}
    {@render mockComposerBody()}
  </div>
{/snippet}
