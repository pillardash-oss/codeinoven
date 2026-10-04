import { randomUUID } from 'node:crypto'
import type {
  OvenSetupConfiguration,
  OvenSetupOperation,
  OvenSetupOperationStatus,
  OvenSetupStep,
  OvenSetupStepStatus
} from '../../lib/ovens'
import { Logger } from '../system/logger'

export class OvenSetupService {
  private operations = new Map<string, OvenSetupOperation>()

  startSetup(ovenId: string, configuration: OvenSetupConfiguration): OvenSetupOperation {
    const existing = this.getOperationForOven(ovenId)
    if (existing && existing.status !== 'succeeded' && existing.status !== 'cancelled') {
      return existing
    }
    const id = randomUUID()
    const operation: OvenSetupOperation = {
      id,
      ovenId,
      status: 'preparing',
      configuration,
      steps: this.createInitialSteps(),
      startedAt: Date.now(),
      updatedAt: Date.now()
    }
    this.operations.set(id, operation)
    Logger.info('Starting oven setup', { ovenId, operationId: id })
    // Mark as running after preparation
    operation.status = 'running'
    operation.updatedAt = Date.now()
    return operation
  }

  getOperation(operationId: string): OvenSetupOperation | null {
    return this.operations.get(operationId) || null
  }

  getOperationForOven(ovenId: string): OvenSetupOperation | null {
    for (const op of this.operations.values()) {
      if (op.ovenId === ovenId && op.status !== 'succeeded' && op.status !== 'cancelled' && op.status !== 'failed') {
        return op
      }
    }
    return null
  }

  cancelSetup(operationId: string): OvenSetupOperation {
    const op = this.operations.get(operationId)
    if (!op) throw new Error('Operation not found')
    op.status = 'cancelled'
    op.finishedAt = Date.now()
    op.updatedAt = Date.now()
    return op
  }

  retrySetup(operationId: string): OvenSetupOperation {
    const op = this.operations.get(operationId)
    if (!op) throw new Error('Operation not found')
    op.status = 'preparing'
    op.error = undefined
    op.finishedAt = undefined
    op.updatedAt = Date.now()
    op.status = 'running'
    op.updatedAt = Date.now()
    return op
  }

  completeSetup(operationId: string): OvenSetupOperation {
    const op = this.operations.get(operationId)
    if (!op) throw new Error('Operation not found')
    op.status = 'succeeded'
    op.finishedAt = Date.now()
    op.updatedAt = Date.now()
    for (const step of op.steps) {
      step.status = 'succeeded'
      if (!step.finishedAt) step.finishedAt = Date.now()
    }
    return op
  }

  failSetup(operationId: string, error: string): OvenSetupOperation {
    const op = this.operations.get(operationId)
    if (!op) throw new Error('Operation not found')
    op.status = 'failed'
    op.error = error
    op.finishedAt = Date.now()
    op.updatedAt = Date.now()
    return op
  }

  private createInitialSteps(): OvenSetupStep[] {
    const steps = [
      { id: 'preflight', name: 'Preflight checks' },
      { id: 'prerequisites', name: 'Prerequisites' },
      { id: 'harnesses', name: 'Install harnesses' },
      { id: 'accounts', name: 'Synchronize accounts' },
      { id: 'git', name: 'Git SSH setup' },
      { id: 'finalize', name: 'Finalize' }
    ]
    return steps.map(s => ({
      id: s.id,
      name: s.name,
      status: 'pending' as OvenSetupStepStatus,
      startedAt: undefined,
      finishedAt: undefined
    }))
  }
}
