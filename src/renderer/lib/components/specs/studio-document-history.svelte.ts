import { SvelteMap } from 'svelte/reactivity'

const HISTORY_LIMIT = 50

function copySnapshot<T>(value: T): T {
  return structuredClone(value)
}

function snapshotFingerprint<T>(value: T): string {
  return JSON.stringify(value) ?? ''
}

export class StudioDocumentHistory<T> {
  private undoStack = $state.raw<T[]>([])
  private redoStack = $state.raw<T[]>([])
  private present = $state.raw<T | null>(null)
  private presentFingerprint = $state<string | null>(null)
  private savedFingerprint = $state<string | null>(null)

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  get dirty(): boolean {
    return this.presentFingerprint !== null && this.presentFingerprint !== this.savedFingerprint
  }

  attach(initial: T): T {
    if (this.present === null) {
      const snapshot = copySnapshot(initial)
      const fingerprint = snapshotFingerprint(snapshot)
      this.present = snapshot
      this.presentFingerprint = fingerprint
      this.savedFingerprint = fingerprint
    }
    return copySnapshot(this.present)
  }

  record(value: T): void {
    const snapshot = copySnapshot(value)
    const fingerprint = snapshotFingerprint(snapshot)
    if (this.present === null) {
      this.present = snapshot
      this.presentFingerprint = fingerprint
      this.savedFingerprint = fingerprint
      return
    }
    if (fingerprint === this.presentFingerprint) return
    this.undoStack = [...this.undoStack, copySnapshot(this.present)].slice(-HISTORY_LIMIT)
    this.redoStack = []
    this.present = snapshot
    this.presentFingerprint = fingerprint
  }

  markSaved(value: T): void {
    const snapshot = copySnapshot(value)
    const fingerprint = snapshotFingerprint(snapshot)
    this.present = snapshot
    this.presentFingerprint = fingerprint
    this.savedFingerprint = fingerprint
  }

  undo(current: T): T | null {
    const previous = this.undoStack.at(-1)
    if (!previous) return null
    this.undoStack = this.undoStack.slice(0, -1)
    this.redoStack = [copySnapshot(current), ...this.redoStack].slice(0, HISTORY_LIMIT)
    this.present = copySnapshot(previous)
    this.presentFingerprint = snapshotFingerprint(previous)
    return copySnapshot(previous)
  }

  redo(current: T): T | null {
    const next = this.redoStack[0]
    if (!next) return null
    this.redoStack = this.redoStack.slice(1)
    this.undoStack = [...this.undoStack, copySnapshot(current)].slice(-HISTORY_LIMIT)
    this.present = copySnapshot(next)
    this.presentFingerprint = snapshotFingerprint(next)
    return copySnapshot(next)
  }
}

export class StudioDocumentHistoryCollection<T> {
  private histories = new SvelteMap<string, StudioDocumentHistory<T>>()

  forDocument(key: string): StudioDocumentHistory<T> {
    let history = this.histories.get(key)
    if (!history) {
      history = new StudioDocumentHistory<T>()
      this.histories.set(key, history)
    }
    return history
  }

  hasUnsavedChanges(): boolean {
    return [...this.histories.values()].some((history) => history.dirty)
  }

  clear(): void {
    this.histories.clear()
  }
}
