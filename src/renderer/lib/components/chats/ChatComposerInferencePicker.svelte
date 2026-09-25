<script lang="ts">
  import { Zap } from '@lucide/svelte'
  import type { InferenceMode } from '$shared/types'

  interface Props {
    inferenceMode: InferenceMode
    /** Usage multiplier shown on the fast row. */
    fastMultiplier: number
    menuOpen: boolean
    onToggle: () => void
    onClose: () => void
    onSelect: (mode: InferenceMode) => void
  }

  let { inferenceMode, fastMultiplier, menuOpen, onToggle, onClose, onSelect }: Props = $props()
</script>

<!-- Fast inference   native harness tier or catalog-provided fast variant -->
<div class="relative">
  <button
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground {inferenceMode ===
    'fast'
      ? 'text-accent'
      : ''}"
    aria-label={`Inference mode: ${inferenceMode === 'fast' ? 'Fast' : 'Normal'}`}
    title="Inference mode   fast prioritizes speed over cost"
    onclick={onToggle}
  >
    <Zap
      size={13}
      class={inferenceMode === 'fast' ? 'text-accent' : ''}
      fill={inferenceMode === 'fast' ? 'currentColor' : 'none'}
    />
  </button>

  {#if menuOpen}
    <button class="fixed inset-0 z-30 cursor-default" aria-label="Close menu" onclick={onClose}
    ></button>
    <div
      class="absolute bottom-9 left-0 z-40 w-52 overflow-hidden rounded-xl border bg-surface shadow-lg"
    >
      <div class="p-1">
        <button
          class="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-elevated {inferenceMode ===
          'normal'
            ? 'text-primary'
            : 'text-foreground'}"
          title="Normal inference   full-cost standard tier"
          onclick={() => onSelect('normal')}
        >
          Normal
        </button>
        <button
          class="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-elevated {inferenceMode ===
          'fast'
            ? 'text-primary'
            : 'text-foreground'}"
          title="Fast inference   prioritizes speed over cost"
          onclick={() => onSelect('fast')}
        >
          <span class="flex flex-col">
            <span>Fast</span>
            <span class="text-[0.625rem] text-muted">~{fastMultiplier}× usage</span>
          </span>
        </button>
      </div>
    </div>
  {/if}
</div>
