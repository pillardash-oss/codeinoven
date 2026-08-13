import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { MockOpenCodeAdapter } from '../lib/adapters/opencode/mock'
import type { ProviderAdapter } from '../lib/adapters/adapter.interface'

/**
 * ProviderOrchestrator — runs provider adapters in the main process and exposes
 * them over IPC. Adapters depend on Node APIs (crypto, pty), so they must live
 * here rather than in the renderer.
 *
 * Currently backed by MockOpenCodeAdapter; swap in the real OpenCodeAdapter
 * (PTY-driven) once the CLI binary is available.
 */
export class ProviderOrchestrator {
  private adapter: ProviderAdapter

  constructor() {
    this.adapter = new MockOpenCodeAdapter()
  }

  register(): void {
    ipcMain.handle('provider:generatePlan', (_, task: string) => this.generatePlan(task))
    ipcMain.handle('provider:health', () => this.adapter.healthCheck())
  }

  /** Ask the provider to produce a plan for a task. Resolves with the full plan text. */
  async generatePlan(task: string): Promise<string> {
    await this.adapter.initialize({ id: this.adapter.id, adapter: this.adapter.id, config: {} })

    const session = await this.adapter.startSession({
      command: this.adapter.id,
      args: [],
      projectPath: ''
    })

    let buffer = ''
    this.adapter.onOutput(session.id, (chunk) => {
      buffer += chunk
    })

    await this.adapter.send(session.id, task)
    return buffer
  }
}
