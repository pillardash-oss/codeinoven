<script lang="ts">
  import { STAGE_COLORS, type ThreadStage } from '$lib/stores/scope.svelte'

  type Props = {
    stage?: ThreadStage
    kind?: 'completed' | 'attention' | 'error'
    color?: string
    variant?: 'dot' | 'spinner'
    size?: 'sm' | 'md' | 'lg'
    animated?: boolean
    title?: string
    class?: string
  }

  let {
    stage,
    kind,
    color,
    variant = 'dot',
    size = 'sm',
    animated = false,
    title,
    class: className = ''
  }: Props = $props()

  let resolvedColor = $derived.by((): string => {
    if (color) return color
    if (stage) return STAGE_COLORS[stage]
    if (kind) {
      switch (kind) {
        case 'completed':
          return 'var(--color-thread-done)'
        case 'attention':
          return 'var(--color-warning)'
        case 'error':
          return 'var(--color-danger)'
      }
    }
    return 'var(--color-dimmed)'
  })

  let sizeClass = $derived.by((): string => {
    switch (size) {
      case 'sm':
        return 'h-1.5 w-1.5'
      case 'md':
        return 'h-2 w-2'
      case 'lg':
        return 'h-2.5 w-2.5'
    }
  })

  let label = $derived(title ?? stage ?? kind ?? 'status')
</script>

{#if variant === 'spinner'}
  <span
    class="{sizeClass} shrink-0 animate-spin rounded-full border-2 border-transparent bg-transparent {className}"
    style="border-top-color: {resolvedColor}; border-right-color: {resolvedColor};"
    role="status"
    aria-label={label}
    title={label}
  ></span>
{:else}
  <span
    class="{sizeClass} shrink-0 rounded-full {animated ? 'animate-pulse' : ''} {className}"
    style="background: {resolvedColor}"
    role="status"
    aria-label={label}
    title={label}
  ></span>
{/if}
