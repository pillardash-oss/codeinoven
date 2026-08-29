/// <reference types="vite/client" />

import type { HeartbeatConfig } from '$shared/types'
import { invoke } from '$lib/ipc.svelte'

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

  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      this.heartbeats = await invoke('heartbeat:list')
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
