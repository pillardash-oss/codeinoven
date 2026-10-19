/**
 * The confirmation queue for actions the user starts from a menu.
 *
 * A menu closes the moment an item is chosen, so a dialog rendered inside that
 * menu would unmount with it. This store lets any caller raise one confirmation
 * from the app root instead: `request` returns a promise that settles with the
 * user's answer, and the single host dialog answers one request at a time.
 */
export interface AppConfirmOptions {
  title: string
  /** Body copy, one entry per paragraph. */
  body: string[]
  confirmLabel: string
  cancelLabel?: string
  /** Extra emphasis under the body, e.g. that the action cannot be undone. */
  note?: string
  /** `danger` destroys work; `primary` only moves state, such as archiving. */
  tone?: 'danger' | 'primary'
}

interface PendingConfirm {
  id: number
  options: AppConfirmOptions
  settle: (approved: boolean) => void
}

class AppConfirmStore {
  pending = $state<PendingConfirm[]>([])
  #nextId = 1

  get current(): PendingConfirm | null {
    return this.pending[0] ?? null
  }

  /** Raise a confirmation and wait for the answer. Never answers on its own. */
  request(options: AppConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((settle) => {
      this.pending = [...this.pending, { id: this.#nextId++, options, settle }]
    })
  }

  /** Answer the request on screen and move on to whatever was queued behind it. */
  answer(approved: boolean): void {
    const request = this.current
    if (!request) return
    this.pending = this.pending.filter((candidate) => candidate.id !== request.id)
    request.settle(approved)
  }
}

export const appConfirm = new AppConfirmStore()
