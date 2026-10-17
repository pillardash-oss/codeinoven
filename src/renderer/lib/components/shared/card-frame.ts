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

export interface CardFrameJoin {
  /**
   * Another surface sits directly above this card, so its top rule is the broken
   * line that separates two stacked surfaces rather than a solid edge.
   */
  stackedAbove?: boolean
  /**
   * The surface below carries the join (another stack card, or the composer with
   * its dashed top rule), so this card drops its own bottom rule. The surfaces
   * then touch and one rule marks the boundary instead of two.
   */
  joinsBelow?: boolean
}

export function cardFrameClass(
  placement: CardFramePlacement,
  className = '',
  join: CardFrameJoin = {}
): string {
  const mark =
    placement === 'replace'
      ? 'border-l-[3px] border-l-foreground'
      : 'border-l-[3px] border-l-dimmed'
  return [
    'flex min-w-0 flex-col border bg-surface',
    'border-border',
    join.joinsBelow ? 'border-b-0' : '',
    join.stackedAbove ? 'border-t-border-strong [border-top-style:dashed]' : '',
    mark,
    className
  ]
    .filter((part) => part.length > 0)
    .join(' ')
}
