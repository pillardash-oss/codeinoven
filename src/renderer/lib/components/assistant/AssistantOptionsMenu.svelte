<script lang="ts">
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import type { Snippet } from 'svelte'
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioCalendar from '@pdslng/cio-icon/CioCalendar.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPin from '@pdslng/cio-icon/CioPin.svelte'
  import CioPinOff from '@pdslng/cio-icon/CioPinOff.svelte'
  import CioSkipForward from '@pdslng/cio-icon/CioSkipForward.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { DropdownMenu } from 'bits-ui'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { archiveItem } from '$lib/archive-actions'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { assistants as assistantStore } from '$lib/stores/assistants.svelte'
  import { assistantHeaderTabs } from '$lib/stores/assistant-header-tabs.svelte'
  import { assistantIsScheduled, type Assistant } from '$shared/types'
  import AssistantEditModal from './AssistantEditModal.svelte'

  /**
   * The assistant's own menu, opened from its mark in the assistant view's header.
   *
   * It is the only place the assistant's settings live now: the sidebar row is a
   * plain row, so the mark beside the name is the door to behaviour, appearance,
   * schedule, pinning and removal. The caller supplies the trigger itself, so the
   * mark can become a chevron under the pointer and either mouse button can open
   * the same menu.
   */
  interface Props {
    assistant: Assistant
    open?: boolean
    children: Snippet
  }

  let { assistant, open = $bindable(false), children }: Props = $props()

  let hasRunsToday = $state(false)
  let editOpen = $state(false)
  let deleteOpen = $state(false)
  let deleteBusy = $state(false)
  let skipConfirm = $state<'next' | 'today' | null>(null)
  let skipBusy = $state(false)
  let todayRunsCheck = 0

  const scheduled = $derived(assistantIsScheduled(assistant))
  const skipDialogTitle = $derived(
    skipConfirm === 'today' ? "Skip today's runs?" : 'Skip next run?'
  )
  const skipConfirmLabel = $derived(skipConfirm === 'today' ? 'Skip for today' : 'Skip next run')

  function onMenuOpenChange(next: boolean): void {
    if (!next) {
      todayRunsCheck += 1
      hasRunsToday = false
      return
    }
    const check = ++todayRunsCheck
    hasRunsToday = false
    void assistantStore
      .hasRunsToday(assistant.id)
      .then((hasRuns) => {
        if (open && check === todayRunsCheck) hasRunsToday = hasRuns
      })
      .catch(() => {
        if (check === todayRunsCheck) hasRunsToday = false
      })
  }

  async function confirmSkip(): Promise<void> {
    const action = skipConfirm
    if (!action || skipBusy) return
    skipBusy = true
    try {
      if (action === 'next') await assistantStore.skipNextRun(assistant.id)
      else await assistantStore.skipRunsToday(assistant.id)
      skipConfirm = null
    } catch (caught) {
      reportError(caught, 'Could not skip this assistant’s run')
    } finally {
      skipBusy = false
    }
  }

  async function confirmDelete(): Promise<void> {
    if (deleteBusy) return
    deleteBusy = true
    try {
      await assistantHeaderTabs.deleteAssistant(assistant.id)
      deleteOpen = false
    } catch (caught) {
      reportError(caught, 'Could not remove this assistant')
    } finally {
      deleteBusy = false
    }
  }

  async function togglePin(): Promise<void> {
    try {
      await assistantStore.setAssistantPinned(assistant.id, !assistant.pinned)
    } catch (caught) {
      reportError(caught, 'Could not change this assistant’s pin')
    }
  }
</script>

<DropdownMenu.Root bind:open onOpenChange={onMenuOpenChange}>
  <DropdownMenu.Trigger
    class="flex shrink-0 items-center justify-center outline-none"
    aria-label="Options for {assistant.name}"
    title="Assistant options"
    oncontextmenu={(event: MouseEvent) => {
      event.preventDefault()
      open = true
    }}
  >
    {@render children()}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      class="z-50 w-56 overflow-hidden border bg-surface p-1 whitespace-nowrap shadow-lg"
    >
      <DropdownMenu.Item
        class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
        onSelect={() => assistantHeaderTabs.openAssistantBehaviour(assistant)}
      >
        <AssistantIcon mark="knowledge" size={14} class="text-muted" />
        Assistant behavior
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
        onSelect={() => (editOpen = true)}
      >
        <CioPencil size={14} class="text-muted" />
        Edit assistant
      </DropdownMenu.Item>
      <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
      {#if scheduled}
        <DropdownMenu.Item
          class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
          onSelect={() => (skipConfirm = 'next')}
        >
          <CioSkipForward size={14} class="text-muted" />
          Skip next run
        </DropdownMenu.Item>
        {#if hasRunsToday}
          <DropdownMenu.Item
            class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
            onSelect={() => (skipConfirm = 'today')}
          >
            <CioCalendar size={14} class="text-muted" />
            Skip runs for today
          </DropdownMenu.Item>
        {/if}
      {/if}
      <DropdownMenu.Item
        class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
        onSelect={() => void togglePin()}
      >
        {#if assistant.pinned}
          <CioPinOff size={14} class="text-muted" />
          Unpin Assistant
        {:else}
          <CioPin size={14} class="text-muted" />
          Pin Assistant
        {/if}
      </DropdownMenu.Item>
      <DropdownMenu.Item
        class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
        onSelect={() => void archiveItem('assistant', assistant.id, assistant.name)}
      >
        <CioArchive size={14} class="text-muted" />
        Archive Assistant
      </DropdownMenu.Item>
      <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
      <DropdownMenu.Item
        class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
        onSelect={() => (deleteOpen = true)}
      >
        <CioTrash size={14} />
        Remove Assistant
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>

<AssistantEditModal assistant={editOpen ? assistant : null} onClose={() => (editOpen = false)} />

<ConfirmDialog
  open={deleteOpen}
  title="Remove assistant"
  confirmLabel="Remove assistant"
  busy={deleteBusy}
  note="This cannot be undone."
  onCancel={() => (deleteOpen = false)}
  onConfirm={confirmDelete}
>
  <p>
    Remove <strong class="text-foreground">{assistant.name}</strong>? Its tasks, the runs they
    produced, and its artifact folder are deleted with it.
  </p>
</ConfirmDialog>

<ConfirmDialog
  open={skipConfirm !== null}
  title={skipDialogTitle}
  confirmLabel={skipConfirmLabel}
  busy={skipBusy}
  variant="primary"
  onCancel={() => (skipConfirm = null)}
  onConfirm={confirmSkip}
>
  {#if skipConfirm === 'today'}
    <p>
      Skip all remaining scheduled runs for <strong class="text-foreground">{assistant.name}</strong
      >
      today? The assistant will resume at its next scheduled time after today.
    </p>
  {:else}
    <p>
      Skip the closest scheduled run for <strong class="text-foreground">{assistant.name}</strong>?
      The next run after that will stay scheduled.
    </p>
  {/if}
</ConfirmDialog>
