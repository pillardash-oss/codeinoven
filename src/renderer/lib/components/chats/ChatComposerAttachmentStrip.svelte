<script lang="ts">
  import {
    Clapperboard,
    Clock,
    FileText,
    HardDrive,
    MessageSquare,
    PenLine,
    SquareDashedMousePointer,
    X
  } from '@lucide/svelte'
  import AttachmentPill from './AttachmentPill.svelte'
  import SelectionListPopover from './SelectionListPopover.svelte'
  import { summarizeComposerReferences } from './composer-reference-summary'
  import type { StartAfterSelection } from './chat-composer-attachments'
  import type { PromptAttachment, PromptReference } from '$shared/types'

  interface Props {
    attachments: PromptAttachment[]
    references: readonly PromptReference[]
    startAfterThreads: StartAfterSelection[]
    /** Chat view only: surfaces the chat-only File System mode chip. */
    showChatModes: boolean
    /** Chat view only: whether File System mode is currently on. */
    fileSystemMode: boolean | undefined
    /** Object URLs for image attachment thumbnails, keyed by `file://` URL. */
    previewUrls: Record<string, string>
    onPreviewAttachment: (file: PromptAttachment) => void
    onRemoveAttachment: (index: number) => void
    onToggleFileSystemMode: () => void
    startAfterPopoverOpen: boolean
    onOpenStartAfterPopover: () => void
    onScheduleStartAfterPopoverClose: () => void
    onCloseStartAfterPopover: () => void
    onClearStartAfterThreads: () => void
    onOpenStartAfterThread?: (threadId: string) => void | Promise<void>
    onRemoveStartAfterThread: (threadId: string) => void
    selectionPopoverOpen: boolean
    onOpenSelectionPopover: () => void
    onScheduleSelectionPopoverClose: () => void
    onToggleSelectionPopover: () => void
    onCloseSelectionPopover: () => void
    onEditReference?: (id: string) => void
    onRemoveReference?: (id: string) => void
    onRemoveAllReferences?: () => void
  }

  let {
    attachments,
    references,
    startAfterThreads,
    showChatModes,
    fileSystemMode,
    previewUrls,
    onPreviewAttachment,
    onRemoveAttachment,
    onToggleFileSystemMode,
    startAfterPopoverOpen,
    onOpenStartAfterPopover,
    onScheduleStartAfterPopoverClose,
    onCloseStartAfterPopover,
    onClearStartAfterThreads,
    onOpenStartAfterThread,
    onRemoveStartAfterThread,
    selectionPopoverOpen,
    onOpenSelectionPopover,
    onScheduleSelectionPopoverClose,
    onToggleSelectionPopover,
    onCloseSelectionPopover,
    onEditReference,
    onRemoveReference,
    onRemoveAllReferences
  }: Props = $props()

  /** Wording for the reference count, which carries both response selections and
   *  picked design elements. */
  const referenceSummary = $derived(summarizeComposerReferences(references))
</script>

<!-- Attachment chips (project identity + type + branch now live on the scope shoe) -->
{#if attachments.length > 0 || references.length > 0 || startAfterThreads.length > 0 || (showChatModes && fileSystemMode)}
  <div class="flex flex-col gap-1.5 px-3 pt-2.5">
    <div class="flex flex-wrap items-center gap-1.5">
      {#if showChatModes && fileSystemMode}
        <div class="flex flex-wrap items-center gap-1.5" aria-label="Active chat modes">
          {#if fileSystemMode}
            <span
              class="flex shrink-0 items-center gap-1 border border-info/30 bg-info/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-info uppercase"
            >
              <HardDrive size={9} class="shrink-0" />
              <span>File System</span>
              <button
                type="button"
                class="shrink-0 text-info/60 transition-colors hover:text-info"
                title="Turn off File System"
                aria-label="Turn off File System"
                onclick={onToggleFileSystemMode}
              >
                <X size={9} />
              </button>
            </span>
          {/if}
        </div>
      {/if}
      {#if startAfterThreads.length > 0}
        <div
          class="relative inline-flex"
          role="group"
          aria-label="Start after dependencies"
          onmouseenter={onOpenStartAfterPopover}
          onmouseleave={onScheduleStartAfterPopoverClose}
        >
          <div
            class="flex items-center border border-info/30 bg-info/10 text-[0.625rem] font-medium text-info transition-colors hover:bg-info/15"
          >
            <button
              type="button"
              class="flex items-center gap-1.5 px-2 py-1"
              title={`Starts after ${startAfterThreads.length} ${startAfterThreads.length === 1 ? 'thread' : 'threads'}   hover to manage`}
              aria-label={`Starts after ${startAfterThreads.length} ${startAfterThreads.length === 1 ? 'thread' : 'threads'}`}
              aria-expanded={startAfterPopoverOpen}
              onclick={() => {
                if (startAfterPopoverOpen) onCloseStartAfterPopover()
                else onOpenStartAfterPopover()
              }}
            >
              <Clock size={10} class="shrink-0" />
              <span
                >Start after{startAfterThreads.length > 1
                  ? ` · ${startAfterThreads.length}`
                  : ''}</span
              >
            </button>
            <button
              type="button"
              class="flex h-full items-center pl-0.5 pr-1.5 text-info/70 transition-colors hover:text-danger"
              title="Remove all Start after threads"
              aria-label="Remove all Start after threads"
              onclick={onClearStartAfterThreads}
            >
              <X size={10} />
            </button>
          </div>
          {#if startAfterPopoverOpen}
            <div
              class="absolute bottom-full left-0 z-50 mb-1.5 w-72 border border-border bg-surface p-2 shadow-lg"
              role="dialog"
              aria-label="Start after details"
              tabindex="0"
              onmouseenter={onOpenStartAfterPopover}
              onmouseleave={onScheduleStartAfterPopoverClose}
            >
              <div
                class="px-2 pb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed"
              >
                Starts after thread{startAfterThreads.length === 1 ? '' : 's'}
              </div>
              {#each startAfterThreads as selectedStartAfterThread (selectedStartAfterThread.id)}
                <div class="flex items-center gap-1">
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated"
                    title={'Open ' + selectedStartAfterThread.title}
                    aria-label={'Open ' + selectedStartAfterThread.title}
                    onclick={() => void onOpenStartAfterThread?.(selectedStartAfterThread.id)}
                  >
                    <Clock size={12} class="shrink-0 text-info" />
                    <span class="min-w-0 flex-1 truncate">
                      {selectedStartAfterThread.title}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="flex h-6 shrink-0 items-center px-1 text-dimmed transition-colors hover:bg-elevated hover:text-danger"
                    title={`Remove ${selectedStartAfterThread.title} from Start after`}
                    aria-label={`Remove ${selectedStartAfterThread.title} from Start after`}
                    onclick={() => onRemoveStartAfterThread(selectedStartAfterThread.id)}
                  >
                    <X size={11} />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
    {#if references.length > 0}
      <div
        role="group"
        aria-label={referenceSummary.aria}
        class="relative inline-flex"
        onmouseenter={onOpenSelectionPopover}
        onmouseleave={onScheduleSelectionPopoverClose}
      >
        <div
          class="flex items-center border border-accent/30 bg-accent/10 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-accent/15"
        >
          <button
            type="button"
            class="flex items-center gap-1.5 px-2 py-1"
            title={`${referenceSummary.aria}   hover to manage`}
            aria-label={referenceSummary.aria}
            aria-expanded={selectionPopoverOpen}
            onclick={onToggleSelectionPopover}
          >
            {#if referenceSummary.noun === 'element'}
              <SquareDashedMousePointer size={11} class="shrink-0 text-accent" />
            {:else if referenceSummary.noun === 'annotation'}
              <FileText size={11} class="shrink-0 text-accent" />
            {:else if referenceSummary.noun === 'note'}
              <Clapperboard size={11} class="shrink-0 text-accent" />
            {:else if referenceSummary.noun === 'mark'}
              <PenLine size={11} class="shrink-0 text-accent" />
            {:else}
              <MessageSquare size={11} class="shrink-0 text-accent" />
            {/if}
            <span>
              {referenceSummary.label}
            </span>
          </button>
          {#if onRemoveAllReferences}
            <button
              type="button"
              class="flex h-full items-center pl-0.5 pr-1.5 text-dimmed transition-colors hover:text-danger"
              title={referenceSummary.noun === 'selection'
                ? 'Delete all selections'
                : 'Delete all attached references'}
              aria-label={referenceSummary.noun === 'selection'
                ? 'Delete all selections'
                : 'Delete all attached references'}
              onclick={onRemoveAllReferences}
            >
              <X size={11} />
            </button>
          {/if}
        </div>
        {#if selectionPopoverOpen}
          <div class="absolute bottom-full left-0 z-50 mb-1.5">
            <SelectionListPopover
              {references}
              onEdit={(id) => {
                onCloseSelectionPopover()
                onEditReference?.(id)
              }}
              onRemove={(id) => onRemoveReference?.(id)}
              onRemoveAll={onRemoveAllReferences}
            />
          </div>
        {/if}
      </div>
    {/if}
    {#if attachments.length > 0}
      <div class="flex flex-wrap gap-1.5">
        <!-- Keyed by the `file://` URL, which the duplicate guard above keeps
             unique across drops, picks, pastes, and restored drafts. -->
        {#each attachments as file, i (file.url)}
          <AttachmentPill
            attachment={file}
            previewUrl={previewUrls[file.url]}
            onPreview={onPreviewAttachment}
            onRemove={() => onRemoveAttachment(i)}
          />
        {/each}
      </div>
    {/if}
  </div>
{/if}
