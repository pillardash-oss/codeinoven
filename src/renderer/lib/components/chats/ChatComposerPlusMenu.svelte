<script lang="ts">
  import { Clock, HardDrive, Paperclip, Plus, ShieldCheck, X } from '@lucide/svelte'
  import Switch from '../ui/Switch.svelte'
  import type { StartAfterSelection } from './chat-composer-attachments'

  interface Props {
    open: boolean
    onToggle: () => void
    onClose: () => void
    showChatModes: boolean
    fileSystemMode: boolean | undefined
    onToggleFileSystemMode: () => void
    independentAuditAvailable: boolean
    independentAuditEnabled: boolean
    projectId?: string | null
    readOnlyMode: boolean
    onToggleIndependentAudit: (enabled: boolean) => void
    showEngineeringMode: boolean
    startAfterEnabled: boolean
    startAfterThreads: StartAfterSelection[]
    onToggleStartAfter: (enabled: boolean) => void
    onRemoveStartAfterThread: (threadId: string) => void
    onOpenStartAfterPicker: () => void
    allowAttachments: boolean
    selectedHarnessLacksAttachments: boolean
    onPickAttachment: () => void
  }

  let {
    open,
    onToggle,
    onClose,
    showChatModes,
    fileSystemMode,
    onToggleFileSystemMode,
    independentAuditAvailable,
    independentAuditEnabled,
    projectId = null,
    readOnlyMode,
    onToggleIndependentAudit,
    showEngineeringMode,
    startAfterEnabled,
    startAfterThreads,
    onToggleStartAfter,
    onRemoveStartAfterThread,
    onOpenStartAfterPicker,
    allowAttachments,
    selectedHarnessLacksAttachments,
    onPickAttachment
  }: Props = $props()
</script>

<!-- Plus menu   attachments and project scheduling; Engineering lives in Toolbox. -->
{#if !readOnlyMode || allowAttachments || showEngineeringMode}
  <div class="relative">
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Chat options"
      aria-label="Chat options"
      aria-haspopup="menu"
      aria-expanded={open}
      onclick={onToggle}
    >
      <Plus size={15} class="transition-transform {open ? 'rotate-45' : ''}" />
    </button>

    {#if open}
      <button class="fixed inset-0 z-30 cursor-default" aria-label="Close menu" onclick={onClose}
      ></button>
      <div
        class="absolute bottom-9 left-0 z-40 w-60 rounded-xl border bg-surface p-1 shadow-lg"
        role="menu"
      >
        {#if showChatModes || showEngineeringMode || independentAuditAvailable}
          {#if showChatModes}
            <!-- File System toggle (chat view) -->
            <Switch
              checked={fileSystemMode === true}
              onchange={onToggleFileSystemMode}
              title={fileSystemMode
                ? 'Turn off File System   chat becomes web-only'
                : 'Turn on File System   grant this thread file operations'}
              activeClass="bg-info"
              class="w-full justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
            >
              <span
                class="flex min-w-0 items-center gap-2 {fileSystemMode
                  ? 'text-foreground'
                  : 'text-muted'}"
              >
                <HardDrive size={13} class={fileSystemMode ? 'text-info' : 'text-dimmed'} />
                File System
              </span>
            </Switch>
          {/if}

          {#if independentAuditAvailable && projectId && !readOnlyMode}
            <!-- Independent audit (spec-less) -->
            <Switch
              checked={independentAuditEnabled}
              onchange={(enabled) => void onToggleIndependentAudit(enabled)}
              title="Independent audit that uses the context of the thread to bring up an auditor to audit the current work of the agent"
              aria-label={independentAuditEnabled
                ? 'Turn off Independent audit'
                : 'Turn on Independent audit'}
              activeClass="bg-info"
              class="w-full justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
            >
              <span
                class="flex min-w-0 items-center gap-2 {independentAuditEnabled
                  ? 'text-foreground'
                  : 'text-muted'}"
              >
                <ShieldCheck
                  size={13}
                  class={independentAuditEnabled ? 'text-info' : 'text-dimmed'}
                />
                Independent Audit
              </span>
            </Switch>
          {/if}

          {#if showEngineeringMode && projectId && !readOnlyMode}
            <!-- Start-after dependency -->
            <Switch
              checked={startAfterEnabled}
              onchange={onToggleStartAfter}
              title={startAfterThreads.length > 0
                ? `Start after ${startAfterThreads.length} ${startAfterThreads.length === 1 ? 'thread' : 'threads'}`
                : 'Start this thread after other active threads finish'}
              aria-label="Start after other threads"
              activeClass="bg-info"
              class="w-full justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
            >
              <span
                class="flex min-w-0 items-center gap-2 {startAfterEnabled
                  ? 'text-foreground'
                  : 'text-muted'}"
              >
                <Clock size={13} class={startAfterEnabled ? 'text-info' : 'text-dimmed'} />
                <span class="min-w-0 truncate">
                  {startAfterEnabled && startAfterThreads.length > 0
                    ? `Start after · ${startAfterThreads.length} ${startAfterThreads.length === 1 ? 'thread' : 'threads'}`
                    : 'Start after'}
                </span>
              </span>
            </Switch>
            {#if startAfterEnabled}
              {#each startAfterThreads as startAfterThread (startAfterThread.id)}
                <div class="flex items-center gap-1 px-1">
                  <span class="min-w-0 flex-1 truncate px-1.5 py-0.5 text-[0.6875rem] text-info">
                    {startAfterThread.title}
                  </span>
                  <button
                    type="button"
                    class="flex h-6 shrink-0 items-center rounded-md px-1 text-dimmed transition-colors hover:bg-elevated hover:text-danger"
                    title={`Remove ${startAfterThread.title} from Start after`}
                    aria-label={`Remove ${startAfterThread.title} from Start after`}
                    onclick={() => onRemoveStartAfterThread(startAfterThread.id)}
                  >
                    <X size={11} />
                  </button>
                </div>
              {/each}
              <button
                type="button"
                class="flex w-full items-center rounded-lg px-2.5 py-1 text-left text-[0.6875rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                role="menuitem"
                title="Add another thread to Start after"
                onclick={onOpenStartAfterPicker}
              >
                Add thread
              </button>
            {/if}
          {/if}

          <div class="mx-2 my-1 border-t"></div>
        {/if}

        {#if !readOnlyMode || allowAttachments}
          <!-- Attach file -->
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-foreground transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
            role="menuitem"
            title={selectedHarnessLacksAttachments
              ? 'Attachments are unavailable for this model'
              : 'Attach files to this message'}
            disabled={selectedHarnessLacksAttachments}
            onclick={onPickAttachment}
          >
            <Paperclip size={13} class="text-dimmed" />
            Attach Files
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
