/** Which composer panel is open. One at a time, because every one of them is
 *  anchored to the same row and two would overlap. */
export type ComposerPanel =
  'plus' | 'permission' | 'model' | 'thinking' | 'account' | 'oven' | 'usage' | null
