<script lang="ts">
  import { X } from '@lucide/svelte'

  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'

  /**
   * The file tab strip shared by both surfaces an OS-opened file can take: the
   * docked panel and the fullscreen reader. One file is the common case and needs
   * no strip, so nothing renders until a second file arrives; several files that
   * were handed over at once stay reachable either way.
   */
</script>

{#if standaloneFiles.files.length > 1}
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
          'flex h-5 max-w-52 shrink-0 items-center gap-1.5 rounded px-2 text-[0.625rem] transition-colors',
          file.path === standaloneFiles.activePath
            ? 'bg-overlay text-foreground'
            : 'text-dimmed hover:bg-elevated hover:text-foreground'
        ]}
        aria-selected={file.path === standaloneFiles.activePath}
        title={file.path}
        onclick={() => standaloneFiles.activate(file.path)}
      >
        {#if standaloneFiles.isDirty(file.path)}
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            role="status"
            aria-label="Unsaved changes"
            title="Unsaved changes"
          ></span>
        {/if}
        <span class="truncate">{file.name}</span>
      </button>
      <button
        type="button"
        class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label={`Close ${file.name}`}
        title={`Close ${file.name}`}
        onclick={() => standaloneFiles.requestClose(file.path)}
      >
        <X size={11} />
      </button>
    {/each}
  </div>
{/if}
