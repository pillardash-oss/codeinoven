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
<div class="actions-stack min-w-7" data-onboarding="view-actions" data-guide="view-actions">
  {#key viewActions.view}
    <div
      class="action-layer flex items-center gap-0.5"
      transition:fade={{ duration: motionDuration(180) }}
    >
      {#each viewActions.items as item (item.id)}
        {@render actionControl(item)}
      {/each}
    </div>
  {/key}
</div>

{#snippet actionControl(item: (typeof viewActions.items)[number])}
  {#if item.component}
    {@const ActionControl = item.component}
    <span class="actions-arriving inline-flex">
      <ActionControl {...item.props ?? {}} />
    </span>
  {:else if item.icon && item.run}
    {@const ActionIcon = item.icon}
    <button
      class="actions-arriving flex h-7 w-7 items-center justify-center text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
      aria-label={item.ariaLabel ?? item.title ?? 'Action'}
      title={item.title}
      data-shortcut={item.shortcut ? item.shortcut.join(',') : undefined}
      onclick={() => item.run?.()}
    >
      <ActionIcon size={15} strokeWidth={1.8} />
    </button>
  {/if}
{/snippet}

<style>
  .actions-stack {
    display: grid;
  }

  .action-layer {
    grid-area: 1 / 1;
  }

  .actions-arriving {
    animation: action-arrive 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes action-arrive {
    from {
      transform: scale(0.82) rotate(-8deg);
      opacity: 0.35;
    }
    to {
      transform: scale(1) rotate(0);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .actions-arriving {
      animation: none;
    }
  }
</style>
