/**
 * The base every split board extends.
 *
 * A board builds its units as field initializers, and a unit reads the surface
 * props the moment it is created (`this.root.props.thread`, for example). If the
 * board stored its props thunk in its own constructor body, those reads would
 * happen before it existed. Here the base constructor runs first, so `props` is
 * already readable while the board's fields are evaluated.
 *
 * The board is still built by its component during that component's own setup, so
 * an `$effect` a unit registers is owned by the component and tears down with it.
 */
export abstract class BoardState<Props> {
  #readProps: (() => Props) | undefined

  protected constructor(readProps: () => Props) {
    this.#readProps = readProps
  }

  /**
   * The surface props, read live.
   *
   * Reading through the thunk is what keeps a unit's `$derived` up to date when
   * the surface passes a new value.
   */
  get props(): Props {
    if (!this.#readProps) throw new Error(`${this.constructor.name} was built without its props`)
    return this.#readProps()
  }
}
