<script lang="ts">
  import { DropdownMenu } from 'bits-ui'
  import { AppWindow, Check, ChevronDown, Loader2 } from '@lucide/svelte'
  import type { EditorId } from '$shared/types'
  import { editorPreference } from '$lib/stores/editor-preference.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'

  interface Props {
    disabled?: boolean
    onOpen: () => Promise<void>
  }

  let { disabled = false, onOpen }: Props = $props()
  let opening = $state(false)
  let availableEditors = $derived(editorPreference.availableEditors)
  let preferredName = $derived(editorPreference.preferredInfo?.name ?? 'System Default')
  let preferredIcon = $derived(editorPreference.preferredInfo?.iconDataUrl)

  void editorPreference.load()

  async function open(): Promise<void> {
    if (disabled || opening) return
    opening = true
    try {
      await onOpen()
    } catch (error) {
      reportError(error, 'The file could not be opened')
    } finally {
      opening = false
    }
  }

  async function selectAndOpen(editorId: EditorId): Promise<void> {
    try {
      if (editorId !== editorPreference.preferredEditor) {
        await editorPreference.select(editorId)
      }
      await open()
    } catch (error) {
      reportError(error, 'The editor preference could not be saved')
    }
  }
</script>

<div class="flex h-7 items-stretch overflow-hidden rounded border border-border bg-elevated">
  <button
    type="button"
    class="flex min-w-0 items-center gap-1.5 px-2 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
    aria-label={`Open file in ${preferredName}`}
    title={`Open in ${preferredName}`}
    disabled={disabled || opening}
    onclick={() => void open()}
  >
    {#if opening}
      <Loader2 size={12} class="shrink-0 animate-spin" />
    {:else if preferredIcon}
      <img src={preferredIcon} alt="" class="h-3.5 w-3.5 shrink-0" />
    {:else}
      <AppWindow size={13} class="shrink-0" />
    {/if}
    <span>Open</span>
  </button>

  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex w-6 items-center justify-center border-l border-border text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-40"
      aria-label="Select editor"
      title="Select editor"
      disabled={disabled || opening}
    >
      <ChevronDown size={11} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="end"
        sideOffset={6}
        class="z-50 w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <p class="px-2.5 py-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-dimmed">
          Open file in
        </p>
        {#each availableEditors as editor (editor.id)}
          <DropdownMenu.Item
            class="flex items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground outline-none transition-colors data-[highlighted]:bg-elevated"
            textValue={editor.name}
            onSelect={() => void selectAndOpen(editor.id)}
          >
            {#if editor.iconDataUrl}
              <img src={editor.iconDataUrl} alt="" class="h-4 w-4 shrink-0" />
            {:else}
              <AppWindow size={14} class="shrink-0 text-muted" />
            {/if}
            <span class="min-w-0 flex-1 truncate">{editor.name}</span>
            {#if editorPreference.preferredEditor === editor.id}
              <Check size={13} class="shrink-0 text-primary" />
            {/if}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
</div>
