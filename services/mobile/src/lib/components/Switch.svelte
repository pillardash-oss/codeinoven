<script lang="ts">
  import { Switch } from 'bits-ui'

  /**
   * The app's switch, on the same primitive the desktop uses: bits-ui owns the
   * role, the keyboard handling and the checked state contract, so no screen
   * hand-rolls a click handler over a button that only looks like a switch.
   * The drawing stays the design's `.sw` square, not a rounded track.
   */
  interface Props {
    checked: boolean
    /** What the control does, in words, for a screen reader and a tooltip. */
    label: string
    disabled?: boolean
    onchange?: (checked: boolean) => void
  }

  let { checked = $bindable(false), label, disabled = false, onchange }: Props = $props()
</script>

<Switch.Root
  bind:checked
  {disabled}
  class="sw"
  aria-label={label}
  title={label}
  onCheckedChange={(next: boolean) => onchange?.(next)}
/>
