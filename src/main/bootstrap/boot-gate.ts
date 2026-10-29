/**
 * A value one part of the boot publishes, awaited by a boundary that can run
 * before it does.
 *
 * The `appfile://` preview protocol must be installed before the renderer loads,
 * but the services it needs are built by the post-paint boot, which starts after
 * the first paint. A preview requested in between therefore has nothing to read
 * yet, and answering "not found" leaves that image broken for the rest of the
 * session, because a browser never retries a preview.
 *
 * A gate answers exactly that: the request awaits the value, the boot publishes
 * it once, and every waiter is released in the same tick. Nothing polls and
 * nothing times out, because the boot already knows when it is done: a boot that
 * fails closes its gates, and a waiter's promise rejects with the reason instead
 * of hanging.
 */

import type { ProjectFilesService } from '../editor/project-files-service'
import { Logger } from '../system/logger'

/** What a gate rejects with: the boot will not publish this after all. */
export class BootUnavailableError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'BootUnavailableError'
  }
}

interface GateWaiter<T> {
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export class BootGate<T> {
  constructor(private readonly label: string) {}

  private value: T | null = null
  private closedReason: string | null = null
  private readonly waiters = new Set<GateWaiter<T>>()

  /** The published value, or null while the boot has not produced it. */
  peek(): T | null {
    return this.value
  }

  /** Publish the value. Later waiters are answered from it immediately. */
  publish(value: T): void {
    if (this.value !== null) return
    Logger.dev('Boot gate published', { gate: this.label, waiters: this.waiters.size })
    this.value = value
    for (const waiter of this.waiters) waiter.resolve(value)
    this.waiters.clear()
  }

  /**
   * The boot gave up. A waiter asked for something that will never arrive, so
   * it is rejected now instead of waiting for a publish that cannot happen.
   */
  close(reason: string): void {
    if (this.value !== null || this.closedReason !== null) return
    this.closedReason = reason
    Logger.dev('Boot gate closed', { gate: this.label, reason, waiters: this.waiters.size })
    for (const waiter of this.waiters) waiter.reject(new BootUnavailableError(reason))
    this.waiters.clear()
  }

  /** The value, awaiting the publish when it has not happened yet. */
  read(): Promise<T> {
    if (this.value !== null) return Promise.resolve(this.value)
    Logger.dev('Boot gate wait', { gate: this.label, closed: this.closedReason !== null })
    if (this.closedReason !== null)
      return Promise.reject(new BootUnavailableError(this.closedReason))
    return new Promise<T>((resolve, reject) => {
      this.waiters.add({ resolve, reject })
    })
  }
}

/**
 * The two things the `appfile://` preview protocol is installed without.
 *
 * They are published by the post-paint boot and read by the protocol, which is
 * registered earlier on purpose, so the gate is what carries one across to the
 * other without either side guessing how long the other takes.
 */
export const appfileProjectFilesGate = new BootGate<ProjectFilesService>('project files')
export const scopedPathResolverGate = new BootGate<(value: unknown) => Promise<string>>(
  'scoped path resolver'
)

/** Close both gates after a boot that will not publish them. */
export function closeAppfileGates(reason: string): void {
  appfileProjectFilesGate.close(reason)
  scopedPathResolverGate.close(reason)
}

/**
 * Settle the appfile gates once the boot has finished, so a preview can never
 * wait on a publish that the boot did not make. A gate that was published is
 * untouched; an unpublished one rejects its waiters with the reason.
 */
export function settleAppfileGates(): void {
  appfileProjectFilesGate.close('The boot finished without publishing it')
  scopedPathResolverGate.close('The boot finished without publishing it')
}
