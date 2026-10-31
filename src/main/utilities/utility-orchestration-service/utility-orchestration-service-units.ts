import type { UtilityOrchestrationService } from '../utility-orchestration-service'
import { UtilityOrchestrationServiceCapabilityInvoke } from './utility-orchestration-service-capability-invoke'
import { UtilityOrchestrationServiceOrchestration } from './utility-orchestration-service-orchestration'
import { UtilityOrchestrationServiceGatewayEndpoints } from './utility-orchestration-service-gateway-endpoints'
import { UtilityOrchestrationServiceExecutors } from './utility-orchestration-service-executors'
import { UtilityOrchestrationServiceToolCatalog } from './utility-orchestration-service-tool-catalog'
import { UtilityOrchestrationServiceTurnRuntime } from './utility-orchestration-service-turn-runtime'
import { UtilityOrchestrationServiceDiagnostics } from './utility-orchestration-service-diagnostics'
import { UtilityOrchestrationServiceMcpLifecycle } from './utility-orchestration-service-mcp-lifecycle'

/** The concern units a UtilityOrchestrationService delegates to, built once in its constructor. */
export function buildUtilityOrchestrationServiceUnits(engine: UtilityOrchestrationService) {
  return {
    'capability-invoke': new UtilityOrchestrationServiceCapabilityInvoke(engine),
    orchestration: new UtilityOrchestrationServiceOrchestration(engine),
    'gateway-endpoints': new UtilityOrchestrationServiceGatewayEndpoints(engine),
    executors: new UtilityOrchestrationServiceExecutors(engine),
    'tool-catalog': new UtilityOrchestrationServiceToolCatalog(engine),
    'turn-runtime': new UtilityOrchestrationServiceTurnRuntime(engine),
    diagnostics: new UtilityOrchestrationServiceDiagnostics(engine),
    'mcp-lifecycle': new UtilityOrchestrationServiceMcpLifecycle(engine)
  } as const
}

export type UtilityOrchestrationServiceUnits = ReturnType<
  typeof buildUtilityOrchestrationServiceUnits
>
