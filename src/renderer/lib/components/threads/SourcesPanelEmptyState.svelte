<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title: string
    description: string
    /** Optional glyph rendered above the title. */
    icon?: Snippet
    /** Optional actions rendered below the description. */
    children?: Snippet
  }

  let { title, description, icon, children }: Props = $props()
</script>

<div class="flex h-full items-center justify-center px-8 text-center">
  <div class="max-w-64">
    {#if icon}
      <span
        class="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-dimmed"
      >
        {@render icon()}
      </span>
    {/if}
    <h2 class="mt-3 text-sm font-semibold text-foreground">{title}</h2>
    <p class="mt-1 text-xs leading-relaxed text-dimmed">{description}</p>
    {@render children?.()}
  </div>
</div>
