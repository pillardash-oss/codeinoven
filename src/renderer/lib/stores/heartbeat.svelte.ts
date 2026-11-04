/// <reference types="vite/client" />

import type { HeartbeatConfig } from '$shared/types'
import { invoke } from '$lib/ipc.svelte'
import { registerAppControlRevalidation } from '$lib/app-control/app-control-revalidation'

export type HeartbeatCreateInput = Omit<HeartbeatConfig, 'id' | 'lastRun'>
export type HeartbeatPatchInput = Partial<Omit<HeartbeatConfig, 'id'>>

/**
 * Reactive store for Heartbeat pings — timed "keep the usage window warm"
 * completions against a user-picked model. Mirrors the main-process
 * {@link HeartbeatSchedulerService} over the typed IPC contract.
 */
class HeartbeatStore {
  heartbeats = $state.raw<HeartbeatConfig[]>([])
  loading = $state(false)
  saving = $state(false)
  error = $state('')
  /** Whether the list has been read in this window, so a revalidation knows
   *  there is an on-screen list to correct. */
  private loaded = false

  /** Whether this window already holds a read of the schedule. */
  get loadedOnce(): boolean {
    return this.loaded
  }

  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      this.heartbeats = await invoke('heartbeat:list')
      this.loaded = true
    } catch (loadError) {
      this.error = loadError instanceof Error ? loadError.message : 'Failed to load heartbeats.'
    } finally {
      this.loading = false
    }
  }

  async create(input: HeartbeatCreateInput): Promise<HeartbeatConfig> {
    this.saving = true
    try {
      const created = await invoke('heartbeat:create', input)
      this.heartbeats = [...this.heartbeats, created]
      return created
    } finally {
      this.saving = false
    }
  }

  async update(id: string, patch: HeartbeatPatchInput): Promise<HeartbeatConfig> {
    this.saving = true
    try {
      const updated = await invoke('heartbeat:update', id, patch)
      this.heartbeats = this.heartbeats.map((entry) => (entry.id === id ? updated : entry))
      return updated
    } finally {
      this.saving = false
    }
  }

  async trigger(id: string): Promise<void> {
    await invoke('heartbeat:trigger', id)
    this.heartbeats = await invoke('heartbeat:list')
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const updated = await invoke('heartbeat:toggle', id, enabled)
    this.heartbeats = this.heartbeats.map((entry) => (entry.id === id ? updated : entry))
  }

  async remove(id: string): Promise<void> {
    this.saving = true
    try {
      await invoke('heartbeat:delete', id)
      this.heartbeats = this.heartbeats.filter((entry) => entry.id !== id)
    } finally {
      this.saving = false
    }
  }
}

export const heartbeatStore = new HeartbeatStore()

// A ping created, edited, paused or deleted through app control wrote the
// schedule in main without going through this store, so the Routines panel kept
// the schedule it read on mount.
registerAppControlRevalidation({
  channels: ['heartbeat:'],
  refresh: async () => {
    if (!heartbeatStore.loadedOnce) return
    await heartbeatStore.load()
  }
})
