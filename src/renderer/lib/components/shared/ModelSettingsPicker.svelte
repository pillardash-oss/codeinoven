<script lang="ts">
  import { Check, Gauge, Settings2, Snail, Star, Zap } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { modelRuntimeDefaults } from '$lib/stores/model-runtime-defaults.svelte'
  import type { InferenceMode } from '$shared/types'

  interface Props {
    inferenceMode: InferenceMode
    fastSupported: boolean
    ultrafastSupported: boolean
    fastMultiplier: number
    contextWindows: number[]
    contextWindow?: number
    defaultContextWindow?: number
    disabled?: boolean
    menuOpen: boolean
    onSelect: (mode: InferenceMode) => void
    onSelectContext: (tokens?: number) => void
  }

  let {
    inferenceMode,
    fastSupported,
    ultrafastSupported,
    fastMultiplier,
    contextWindows,
    contextWindow,
    defaultContextWindow,
    disabled = false,
    menuOpen = $bindable(false),
    onSelect,
    onSelectContext
  }: Props = $props()

  const speeds = [
    { id: 'normal', label: 'Standard', icon: Snail },
    { id: 'fast', label: 'Fast', icon: Gauge },
    { id: 'ultrafast', label: 'Ultrafast', icon: Zap }
  ] satisfies { id: InferenceMode; label: string; icon: typeof Snail }[]
  let availableSpeeds = $derived(
    speeds.filter(
      (speed) => speed.id === 'normal' || (speed.id === 'fast' ? fastSupported : ultrafastSupported)
    )
  )
  let currentSpeed = $derived(
    availableSpeeds.find((speed) => speed.id === inferenceMode) ?? speeds[0]
  )
  function contextLabel(tokens: number): string {
    return tokens >= 1_000_000 ? `${tokens / 1_000_000}m` : `${tokens / 1_000}k`
  }
  let displayedContextWindow = $derived(
    contextWindow !== undefined && contextWindows.includes(contextWindow)
      ? contextWindow
      : defaultContextWindow
  )
  let summary = $derived(
    `${currentSpeed.label}${displayedContextWindow ? ` · ${contextLabel(displayedContextWindow)}${contextWindow === undefined ? ' (default)' : ''}` : ''}`
  )
</script>

<DropdownMenu.Root bind:open={menuOpen}>
  <DropdownMenu.Trigger
    class="ml-0.5 mr-1.5 flex min-w-0 shrink items-center gap-1 rounded-md bg-elevated px-1.5 py-0.5 text-[0.625rem] text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
    {disabled}
    title={`Model settings: ${summary}`}
    aria-label={`Model settings: ${summary}`}
  >
    <Settings2 size={10} class="shrink-0" />
    <currentSpeed.icon size={10} class="shrink-0" />
    {#if displayedContextWindow}<span aria-hidden="true">·</span><span
        >{contextLabel(displayedContextWindow)}</span
      >{/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={12}
      onCloseAutoFocus={(event) => event.preventDefault()}
      class="z-90 w-52 rounded-xl border border-border bg-surface p-1 shadow-xl"
    >
      <div class="px-2 py-1.5 text-[0.625rem] font-medium text-muted">Speed</div>
      {#each availableSpeeds as speed (speed.id)}
        <DropdownMenu.Item
          class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground outline-none hover:bg-elevated focus:bg-elevated"
          title={`Use ${speed.label.toLowerCase()} speed`}
          onSelect={() => onSelect(speed.id)}
        >
          <speed.icon size={12} class="shrink-0" />
          <span class="flex-1">{speed.label}</span>
          {#if speed.id === 'fast'}<span class="text-[0.625rem] text-muted"
              >~{fastMultiplier}× usage</span
            >{/if}
          {#if currentSpeed.id === speed.id}<Check size={11} class="shrink-0 text-primary" />{/if}
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded text-dimmed hover:bg-overlay hover:text-primary"
            title={modelRuntimeDefaults.settings.inferenceMode === speed.id
              ? `Clear ${speed.label} as default speed`
              : `Set ${speed.label} as default speed`}
            aria-label={modelRuntimeDefaults.settings.inferenceMode === speed.id
              ? `Clear ${speed.label} as default speed`
              : `Set ${speed.label} as default speed`}
            aria-pressed={modelRuntimeDefaults.settings.inferenceMode === speed.id}
            onkeydown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
            }}
            onclick={(event) => {
              event.stopPropagation()
              modelRuntimeDefaults.toggleSpeed(speed.id)
            }}
          >
            <Star
              size={11}
              class={modelRuntimeDefaults.settings.inferenceMode === speed.id
                ? 'fill-primary text-primary'
                : ''}
            />
          </button>
        </DropdownMenu.Item>
      {/each}
      {#if contextWindows.length > 0}
        <DropdownMenu.Separator class="my-1 h-px bg-border" />
        <div class="px-2 py-1.5 text-[0.625rem] font-medium text-muted">Context window</div>
        {#each contextWindows as tokens (tokens)}
          <DropdownMenu.Item
            class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground outline-none hover:bg-elevated focus:bg-elevated"
            title={`Use ${contextLabel(tokens)} context window`}
            onSelect={() => onSelectContext(tokens === defaultContextWindow ? undefined : tokens)}
          >
            <span class="flex-1">{contextLabel(tokens)}</span>
            {#if tokens === displayedContextWindow}<Check
                size={11}
                class="shrink-0 text-primary"
              />{/if}
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center rounded text-dimmed hover:bg-overlay hover:text-primary"
              title={modelRuntimeDefaults.settings.contextWindow === tokens
                ? `Clear ${contextLabel(tokens)} as default context window`
                : `Set ${contextLabel(tokens)} as default context window`}
              aria-label={modelRuntimeDefaults.settings.contextWindow === tokens
                ? `Clear ${contextLabel(tokens)} as default context window`
                : `Set ${contextLabel(tokens)} as default context window`}
              aria-pressed={modelRuntimeDefaults.settings.contextWindow === tokens}
              onkeydown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
              }}
              onclick={(event) => {
                event.stopPropagation()
                modelRuntimeDefaults.toggleContext(tokens)
              }}
            >
              <Star
                size={11}
                class={modelRuntimeDefaults.settings.contextWindow === tokens
                  ? 'fill-primary text-primary'
                  : ''}
              />
            </button>
          </DropdownMenu.Item>
        {/each}
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
