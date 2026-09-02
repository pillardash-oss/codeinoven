<script lang="ts">
  import type { Component } from 'svelte'
  import { STAGE_COLORS, STATUS_TONE_COLORS, type ThreadStage } from '$lib/stores/scope.svelte'
  import type { ThreadStatusTone } from '$shared/thread-status-policy'

  type Props = {
    stage?: ThreadStage
    tone?: ThreadStatusTone
    kind?: 'completed' | 'chat-completed' | 'attention' | 'spec' | 'error'
    color?: string
    variant?: 'dot' | 'spinner' | 'icon'
    /** Icon (Lucide component) rendered when `variant` is 'icon'. */
    icon?: Component | null
    size?: 'sm' | 'md' | 'lg'
    animated?: boolean
    title?: string
    class?: string
  }

  let {
    stage,
    tone,
    kind,
    color,
    variant = 'dot',
    icon = null,
    size = 'sm',
    animated = false,
    title,
    class: className = ''
  }: Props = $props()

  let resolvedColor = $derived.by((): string => {
    if (color) return color
    if (tone) return STATUS_TONE_COLORS[tone]
    if (stage) return STAGE_COLORS[stage]
    if (kind) {
      switch (kind) {
        case 'completed':
          return 'var(--color-thread-done)'
        case 'chat-completed':
          return 'var(--color-chat-success)'
        case 'attention':
          return 'var(--color-warning)'
        case 'spec':
          return 'var(--color-thread-spec)'
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
{:else if variant === 'icon' && icon}
  {@const Icon = icon}
  <span
    class="{className} flex shrink-0 items-center justify-center"
    style="color: {resolvedColor}"
    role="status"
    aria-label={label}
    title={label}
  >
    <Icon size={size === 'sm' ? 12 : size === 'md' ? 14 : 16} aria-hidden="true" />
  </span>
{:else}
  <span
    class="{sizeClass} shrink-0 rounded-full {animated ? 'animate-pulse' : ''} {className}"
    style="background: {resolvedColor}"
    role="status"
    aria-label={label}
    title={label}
  ></span>
{/if}
