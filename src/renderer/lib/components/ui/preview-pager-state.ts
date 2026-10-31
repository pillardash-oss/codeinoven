/**
 * Sibling navigation for a fullscreen preview opened over several files.
 *
 * `index` is zero-based into the caller's own previewable list, which already
 * excludes every file no preview can render: stepping never lands on an empty
 * frame, it moves straight to the next attachment that can be shown.
 *
 * The type lives here rather than in the component so a plain module, and every
 * controller a surface is split into, can name it.
 */
export interface PreviewPagerState {
  index: number
  count: number
  onPrevious: () => void
  onNext: () => void
}
