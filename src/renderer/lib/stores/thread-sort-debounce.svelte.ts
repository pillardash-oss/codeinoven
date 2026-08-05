const DEBOUNCE_MS = 2000

export class ThreadSortDebouncer {
  sortVersion = $state(0)
  private timerId: ReturnType<typeof setTimeout> | undefined = $state()

  touch(): void {
    this.cancel()
    this.timerId = setTimeout(() => {
      this.sortVersion++
      this.timerId = undefined
    }, DEBOUNCE_MS)
  }

  cancel(): void {
    if (this.timerId !== undefined) {
      clearTimeout(this.timerId)
      this.timerId = undefined
    }
  }
}
