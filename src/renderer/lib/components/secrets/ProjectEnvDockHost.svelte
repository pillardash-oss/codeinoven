<script lang="ts">
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import { APP_SLUG } from '$shared/brand'
  import { DEFAULT_ENV_FILE_NAME } from '$shared/project-env'
  import { projectEnvDock } from '$lib/stores/project-env-dock.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import ProjectEnvDock from './ProjectEnvDock.svelte'

  /**
   * Every open project env editor, mounted at the app root.
   *
   * One panel per project, so editing the secrets of one project never replaces
   * the panel of another. The minimized chips share a single dock row instead of
   * one row per dock, so several docked env files sit side by side rather than
   * landing on the same corner of the screen.
   */
  const dockStorageKey = `${APP_SLUG}.projectEnvDocks.v1`

  /** The file a minimized dock is about to show, named the way the picker names it. */
  function targetLabel(group: string, fileName: string | null): string {
    const name = fileName ?? DEFAULT_ENV_FILE_NAME
    return group ? `${group}/${name}` : name
  }
</script>

{#each projectEnvDock.docks as dock, index (dock.id)}
  <ProjectEnvDock
    entry={dock}
    {index}
    storageKey={projectEnvDock.storageKeyFor(dock.id)}
    onMinimize={() => projectEnvDock.minimize(dock.id)}
    onClose={() => projectEnvDock.close(dock.id)}
  />
{/each}

{#if projectEnvDock.minimizedCount > 0}
  <DockRow storageKey={dockStorageKey} label="Move docked env files">
    <div
      class="flex max-w-[calc(100vw-2rem)] items-stretch gap-1 overflow-x-auto border bg-surface p-1.5 shadow-xl"
      role="group"
      aria-label="Docked env files"
    >
      {#each projectEnvDock.minimized as dock (dock.id)}
        {@const label = `${dock.projectName}, ${targetLabel(dock.group, dock.fileName)}`}
        <button
          type="button"
          class="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
          title={`Show the env file for ${label}`}
          aria-label={`Show the env file for ${label}`}
          onclick={() => projectEnvDock.expand(dock.id)}
        >
          {#if dock.iconUrl}
            <img src={dock.iconUrl} alt="" class="h-4 w-4 shrink-0 object-contain" />
          {:else}
            <CioKey size={14} class="shrink-0 text-dimmed" aria-hidden="true" />
          {/if}
          <span class="flex min-w-0 flex-col">
            <span class="max-w-36 truncate text-[0.5625rem] leading-tight font-medium text-muted"
              >{dock.projectName}</span
            >
            <span class="max-w-36 truncate font-mono text-[0.625rem] leading-tight text-foreground"
              >{targetLabel(dock.group, dock.fileName)}</span
            >
          </span>
        </button>
      {/each}
    </div>
  </DockRow>
{/if}
