<script lang="ts">
  import { viewActions } from '$lib/stores/view-actions.svelte'
</script>

<!--
  Per-view quick actions, registered by the workspace store. These stay in the
  app header now that the view switcher itself lives on the left rail, so the
  active view's own controls stay next to the project/thread title.
-->
<div class="flex items-center gap-0.5">
  {#each viewActions.items as item (item.id)}
    {#if item.component}
      {@const ActionControl = item.component}
      <ActionControl {...item.props ?? {}} />
    {:else if item.icon && item.run}
      {@const ActionIcon = item.icon}
      <button
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
        aria-label={item.ariaLabel ?? item.title ?? 'Action'}
        title={item.title}
        data-shortcut={item.shortcut ? item.shortcut.join(',') : undefined}
        onclick={() => item.run?.()}
      >
        <ActionIcon size={15} strokeWidth={1.8} />
      </button>
    {/if}
  {/each}
</div>
