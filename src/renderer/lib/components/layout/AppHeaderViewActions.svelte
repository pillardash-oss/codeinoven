<script lang="ts">
  import { fade } from 'svelte/transition'
  import { viewActions } from '$lib/stores/view-actions.svelte'
  import { motionDuration } from '$lib/motion'
</script>

<!--
  Per-view quick actions, registered by the workspace store. These stay in the
  app header now that the view switcher itself lives on the left rail, so the
  active view's own controls stay next to the project/thread title.
-->
<div class="flex items-center gap-0.5" data-onboarding="view-actions">
  {#each viewActions.items as item (item.id)}
    {#if item.component}
      {@const ActionControl = item.component}
      <span class="inline-flex" in:fade={{ duration: motionDuration(140) }}>
        <ActionControl {...item.props ?? {}} />
      </span>
    {:else if item.icon && item.run}
      {@const ActionIcon = item.icon}
      <button
        in:fade={{ duration: motionDuration(140) }}
        class="flex h-7 w-7 items-center justify-center text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
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
