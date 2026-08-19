import { describe, expect, it } from 'vitest'
import {
  clearPreferredDesktop,
  loadPreferredDesktop,
  savePreferredDesktop
} from '../../../../src/renderer/lib/remote/preferred-desktop'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('preferred remote desktop', () => {
  it('restores the selected desktop until the user explicitly clears it', () => {
    const storage = new MemoryStorage()
    expect(loadPreferredDesktop(storage)).toBeNull()

    savePreferredDesktop('desktop-1', storage)
    expect(loadPreferredDesktop(storage)).toBe('desktop-1')

    clearPreferredDesktop(storage)
    expect(loadPreferredDesktop(storage)).toBeNull()
  })
})
