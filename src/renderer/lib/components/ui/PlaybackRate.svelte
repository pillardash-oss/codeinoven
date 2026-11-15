<script module lang="ts">
  /**
   * The speeds a recording can be played at, slowest first.
   *
   * One is the default and the only rate a fresh player starts on: a recording is
   * heard at its own pace until the reader asks for another. The list is short on
   * purpose, because every rate in it has to be one a person can name, and a
   * dozen steps between 1× and 2× names none of them.
   */
  export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const
</script>

<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import { DropdownMenu } from 'bits-ui'

  /**
   * The app's one playback speed control.
   *
   * Both players draw it in their own row of controls, so it is written once: a
   * button that states the rate the media is running at, and a menu of the rates it
   * can run at. The player owns the element, so the control only names a rate and
   * the caller applies it, which keeps the button usable by the picture, the sound
   * and anything else with a timeline to run faster.
   */
  interface Props {
    /** The media the control belongs to, which names it to a screen reader. */
    label: string
    /** The rate it is running at, which is what the trigger states. */
    rate: number
    /** A picked rate, for the caller to apply to its own element. */
    onRate: (rate: number) => void
    /** Trigger layout classes from the row this stands in. */
    class?: string
    disabled?: boolean
  }

  let { label, rate, onRate, class: layout = '', disabled = false }: Props = $props()

  /** `1×`, `1.5×`, `0.75×`: the number as the reader picked it. */
  function rateLabel(value: number): string {
    return `${value}×`
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={[
      'flex h-7 shrink-0 items-center justify-center px-1 text-[0.6875rem] font-medium tabular-nums outline-none transition-colors',
      layout
    ]}
    aria-label={`Playback speed of ${label}: ${rateLabel(rate)}`}
    title={`Playback speed ${rateLabel(rate)}`}
    {disabled}
  >
    {rateLabel(rate)}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="top"
      align="end"
      sideOffset={6}
      collisionPadding={8}
      class="z-90 min-w-20 border border-border bg-surface p-1 shadow-lg"
    >
      {#each PLAYBACK_RATES as option (option)}
        <DropdownMenu.Item
          class="flex items-center justify-between gap-3 px-2.5 py-1.5 outline-none transition-colors data-[highlighted]:bg-elevated"
          textValue={rateLabel(option)}
          onSelect={() => onRate(option)}
        >
          <span class="text-xs tabular-nums text-foreground">{rateLabel(option)}</span>
          {#if option === rate}
            <CioCheck size={12} class="shrink-0 text-primary" aria-hidden="true" />
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
