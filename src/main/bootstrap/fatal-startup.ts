/**
 * Fatal startup path: deterministically close resources and quit with a
 * nonzero diagnostic code so a failed boot never leaves a headless process.
 * Logs, flushes the durable log, closes the database (and any other
 * initialized resource), shows the error box, then exits(1), falling back to
 * process.exit if the Electron quit callback throws.
 */

import { app, dialog } from 'electron'
import { APP_NAME } from '../../lib/brand'
import type { Database } from '../database/database'
import { handleFatalStartupFailure } from '../system/lifecycle-diagnostics'
import { startupTelemetry } from '../system/startup-telemetry'
import type { BootstrapState } from './bootstrap-state'
import { closeSplash } from './splash-window'

export interface FatalStartupContext {
  state: BootstrapState
  database: Database
}

export async function handleFatalStartup(
  error: unknown,
  context: FatalStartupContext
): Promise<void> {
  const { state } = context
  closeSplash()
  await handleFatalStartupFailure({
    error,
    appName: APP_NAME,
    resources: [
      {
        name: 'database',
        close: () => context.database.close()
      },
      {
        name: 'chatEngine',
        close: () => void state.chatEngine?.dispose()
      },
      {
        name: 'ptyService',
        close: () => state.ptyService?.destroyAll()
      },
      {
        name: 'updaterService',
        close: () => state.updaterService?.stop()
      },
      {
        name: 'skillUpdateService',
        close: () => state.skillUpdateService?.stop()
      },
      {
        name: 'notificationService',
        close: () => state.notificationService?.stop()
      },
      {
        name: 'powerWakeService',
        close: () => state.powerWakeService?.stop()
      },
      {
        name: 'retryScheduler',
        close: () => state.retryScheduler?.dispose()
      },
      {
        name: 'heartbeatScheduler',
        close: () => state.heartbeatScheduler?.dispose()
      },
      {
        name: 'routineScheduler',
        close: () => state.routineScheduler?.dispose()
      },
      {
        name: 'speechService',
        close: () => void state.speechService?.dispose()
      }
    ],
    showErrorBox: (title, message) => dialog.showErrorBox(title, message),
    quit: (code) => app.exit(code),
    telemetry: startupTelemetry
  })
}
