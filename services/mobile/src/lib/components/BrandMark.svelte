<script lang="ts">
  /**
   * The approved CodeInOven mark, inline so it follows the theme. An `<img>` of
   * the same file cannot inherit `currentColor`, which leaves the mark as ink on
   * ink in the dark palette; drawing it here means one mark and no filter trick.
   */
  interface Props {
    size?: number
  }

  let { size = 56 }: Props = $props()
</script>

<svg viewBox="0 0 96 96" width={size} height={size} role="img" aria-label="CodeInOven" fill="none">
  <path
    d="M49 17a31 31 0 1 0 0 62"
    stroke="currentColor"
    stroke-width="8"
    stroke-linecap="square"
    stroke-linejoin="miter"
  />
  <path d="M61 23h23v50H61z" stroke="currentColor" stroke-width="7" stroke-linejoin="miter" />
  <rect x="58" y="45" width="29" height="6" fill="currentColor" />
  <circle cx="84" cy="48" r="5" fill="var(--color-accent)" />
</svg>
