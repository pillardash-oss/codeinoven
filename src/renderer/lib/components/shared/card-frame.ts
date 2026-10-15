/**
 * The frame a composer card wears, in one place.
 *
 * A card's frame says where the card belongs and nothing else: `replace` marks
 * the card that takes the composer's place while it needs an answer, `top` the
 * card that reports on work from the top of the thread. Cards that stack on the
 * composer's edge use `CardStack`, and gates that live on the composer drop the
 * frame entirely, so neither appears here.
 *
 * `cardFrameClass` exists for the one card that cannot render through
 * `CardFrame.svelte`: the question card owns its own root element (a drop
 * region, a measurement attachment and a max-height contract), and it still has
 * to wear the same frame as every other card.
 */
export type CardFramePlacement = 'replace' | 'top'

export function cardFrameClass(placement: CardFramePlacement, className = ''): string {
  const mark =
    placement === 'replace'
      ? 'border-l-[3px] border-l-foreground'
      : 'border-l-[3px] border-l-dimmed'
  return ['flex min-w-0 flex-col border border-border bg-surface', mark, className]
    .filter((part) => part.length > 0)
    .join(' ')
}
