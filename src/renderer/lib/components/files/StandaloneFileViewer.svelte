<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { X } from '@lucide/svelte'

  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import StandaloneFilePane from './StandaloneFilePane.svelte'

  /**
   * Read-only fullscreen viewer for files opened through the operating system
   * ("Open in CodeInOven").
   *
   * It is intentionally project-less: with no project there is no file tree, no
   * tree operations, and no directory index to read or hold in memory   only
   * the single file on screen. The source and preview modes mirror the project
   * editor, so every file type the editor can preview previews here too.
   */
  const active = $derived(standaloneFiles.active)
  const open = $derived(standaloneFiles.open)
</script>

<Dialog.Root
  {open}
  onOpenChange={(next: boolean) => {
    if (!next) standaloneFiles.closeActive()
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/80 backdrop-blur-sm" />
    <Dialog.Content
      class="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-app shadow-xl outline-none"
    >
      <div
        class="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3"
        style={trafficLightInsetStyle()}
      >
        <Dialog.Title class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
          {active?.name ?? 'File'}
        </Dialog.Title>
        <Dialog.Description class="sr-only">
          Standalone read-only file viewer. This file is open on its own, without a project or file
          tree.
        </Dialog.Description>
        <Dialog.Close
          class="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={active ? `Close ${active.name}` : 'Close the file viewer'}
          title="Close the file viewer"
        >
          <X size={14} />
        </Dialog.Close>
      </div>

      {#if standaloneFiles.files.length > 1}
        <!-- One file is the common case (and needs no strip); several files
             arriving at once stay reachable without leaving the viewer. -->
        <div
          class="flex h-7 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2"
          role="tablist"
          aria-label="Open files"
        >
          {#each standaloneFiles.files as file (file.path)}
            <button
              type="button"
              role="tab"
              class={[
                'flex h-5 max-w-52 shrink-0 items-center rounded px-2 text-[0.625rem] transition-colors',
                file.path === standaloneFiles.activePath
                  ? 'bg-overlay text-foreground'
                  : 'text-dimmed hover:bg-elevated hover:text-foreground'
              ]}
              aria-selected={file.path === standaloneFiles.activePath}
              title={file.path}
              onclick={() => standaloneFiles.activate(file.path)}
            >
              <span class="truncate">{file.name}</span>
            </button>
            <button
              type="button"
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              aria-label={`Close ${file.name}`}
              title={`Close ${file.name}`}
              onclick={() => standaloneFiles.close(file.path)}
            >
              <X size={11} />
            </button>
          {/each}
        </div>
      {/if}

      {#if active}
        {#key active.path}
          <StandaloneFilePane path={active.path} name={active.name} />
        {/key}
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
