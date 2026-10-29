/**
 * The base every split controller extends.
 *
 * A controller reads the board it belongs to (`this.root`) from its own field
 * initializers, and a class field is evaluated the moment the class is
 * constructed. If the board were handed over by the subclass's own constructor
 * body, every such read would happen before `root` existed. Here the base
 * constructor runs first, so `root` is set before the subclass's fields are
 * evaluated, and a field may read the board as freely as a method does.
 *
 * It also binds every method to its instance. A controller's method is handed to
 * child components as a callback all over the surfaces this replaces, and a plain
 * method reference loses `this` the moment someone calls it detached. Binding
 * once, here, keeps `this.root` valid however the method is passed along.
 *
 * The board therefore builds its units with `new Unit(this)`, and each unit
 * declares only `constructor(root: Board) { super(root) }`.
 */
export abstract class BoardUnit<Board> {
  #root: Board | undefined

  protected constructor(root: Board) {
    this.#root = root
    bindMethods(this)
  }

  /**
   * The board this unit belongs to.
   *
   * The guard is a development aid, not a runtime state: the base constructor
   * always sets it, so a throw here means a unit was built without its board.
   */
  protected get root(): Board {
    if (!this.#root) throw new Error(`${this.constructor.name} was built without its board`)
    return this.#root
  }
}

/**
 * Bind every method a unit's prototype chain declares.
 *
 * Accessors and data fields are left alone: only a function that is meant to be
 * called needs its receiver.
 */
function bindMethods(unit: object): void {
  const target = unit as Record<string, unknown>
  let prototype = Object.getPrototypeOf(unit) as object | null
  while (prototype && prototype !== BoardUnit.prototype && prototype !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(prototype)) {
      if (key === 'constructor') continue
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
      if (!descriptor || typeof descriptor.value !== 'function') continue
      const bound = (target[key] as ((...args: unknown[]) => unknown) | undefined)?.bind(unit)
      if (bound) target[key] = bound
    }
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
}
