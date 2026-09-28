/**
 * Resume/unlock handling for background scheduling.
 *
 * A machine that slept through a scheduled slot cannot run work while it is
 * asleep, so the honest promise is "runs on time while awake or held awake, and
 * catches up when it wakes". This service owns the second half: when macOS
 * reports the system resumed or the session unlocked, one scheduler evaluation
 * runs and (when the user allows it) the missed assistant slots are dispatched.
 *
 * It runs on the elected owner only, so two instances cannot both catch up the
 * same slot.
 */

import { powerMonitor } from 'electron'
import { Logger } from './logger'
import { instanceRegistry } from './instance-registry'

export interface PowerMonitorDeps {
  /** Evaluate schedules now, then run any pending missed assistant slots. */
  onResume: () => void
}

export class PowerMonitorService {
  private started = false
  private readonly handleResume = (): void => {
    if (!instanceRegistry.isIncumbentInstance()) return
    try {
      this.deps.onResume()
    } catch (error) {
      Logger.error('Resume catch-up failed', error)
    }
  }

  constructor(private readonly deps: PowerMonitorDeps) {}

  start(): void {
    if (this.started) return
    this.started = true
    powerMonitor.on('resume', this.handleResume)
    powerMonitor.on('unlock-screen', this.handleResume)
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    powerMonitor.removeListener('resume', this.handleResume)
    powerMonitor.removeListener('unlock-screen', this.handleResume)
  }
}
