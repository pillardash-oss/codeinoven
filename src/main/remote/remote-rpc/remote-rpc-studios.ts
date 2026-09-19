/**
 * Studio channel handlers for the remote RPC bridge.
 *
 * Spec, assignment, audit, brainstorm, PRD, and engineering-lifecycle channels
 * routed to the same engines and validation the desktop IPC handlers use.
 * Every authorization check already ran in the dispatcher; this module only
 * shapes arguments and calls the service, so the phone sees the identical
 * studio surface as the desktop renderer.
 */

import type { AddPrdAnnotationInput, NewPrdProvenance } from '../../../lib/engines/prd-engine'
import { parseGeneratedPrdContent } from '../../../lib/prd/prd-validation'
import { resolvePrototypePreviewOrigin } from '../../prototypes/prototype-preview-origin'

declare const __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__: string | undefined
import type { NewSpecProvenance, AddSpecAnnotationInput } from '../../../lib/engines/spec-engine'
import type { AddBrainstormAnnotationInput } from '../../../lib/engines/brainstorm-engine'
import type { AddAuditAnnotationInput } from '../../../lib/engines/audit-engine'
import type { AddAssignmentAnnotationInput } from '../../../lib/engines/assignment-engine'
import {
  validateEntityId,
  validateEngineeringLifecycleDecision,
  validateEngineeringLifecycleResumeToken,
  validateEngineeringLifecycleSelectionInput,
  validateEngineeringLifecycleStage
} from '../../ipc/ipc-validation'
import { validateEngineeringSpec } from '../../../lib/spec/spec-validation'
import type {
  AssignmentModelSelection,
  AssignmentPlanContent,
  BrainstormContent,
  EngineeringSpecContent,
  ScopeChoice,
  SpecContextReference,
  SpecValidationIssue
} from '../../../lib/types'
import type { RemoteRpcCallContext } from './remote-rpc-context'
import { REMOTE_RPC_UNHANDLED } from './remote-rpc-context'
import { requireString } from './remote-rpc-args'

export async function callRemoteStudioRpc(
  ctx: RemoteRpcCallContext,
  channel: string,
  args: unknown[]
): Promise<unknown | typeof REMOTE_RPC_UNHANDLED> {
  const { chatEngine } = ctx
  switch (channel) {
    // ─── Spec studio ────────────────────────────────────────────────────
    case 'spec:getActive': {
      const projectId = requireString(args[0])
      const threadId = requireString(args[1])
      const workflow = await ctx.specEngine.getWorkflowState(projectId, threadId)
      if (!workflow?.activeSpecId || !workflow.activeSpecVersion) return null
      return ctx.specEngine.getVersion(
        projectId,
        threadId,
        workflow.activeSpecId,
        workflow.activeSpecVersion
      )
    }
    case 'spec:listVersions':
      return ctx.specEngine.listVersions(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'spec:saveDraft':
      return ctx.specEngine.saveDraft(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as EngineeringSpecContent
      )
    case 'spec:createVersion': {
      const projectId = requireString(args[0])
      const threadId = requireString(args[1])
      const specId = requireString(args[2])
      const content = args[3] as EngineeringSpecContent
      const provenance = (args[4] ?? {}) as NewSpecProvenance
      const latest = await ctx.specEngine.getLatest(projectId, threadId, specId)
      const memory = await ctx.memoryService.snapshotCurrent(projectId, threadId)
      return ctx.specEngine.createVersion({
        projectId,
        threadId,
        specId,
        content,
        provenance,
        context: [
          ...(latest?.context.filter((reference) => reference.type !== 'memory') ?? []),
          ...memory
        ]
      })
    }
    case 'spec:dismissValidationIssue':
      return ctx.specEngine.dismissValidationIssue(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as SpecValidationIssue
      )
    case 'spec:setReview':
      return ctx.specEngine.setReview(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number
      )
    case 'spec:approve':
      return ctx.specEngine.approve(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number
      )
    case 'spec:validate':
      return validateEngineeringSpec(args[0] as Parameters<typeof validateEngineeringSpec>[0])
    case 'spec:addAnnotation':
      return ctx.specEngine.addAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as AddSpecAnnotationInput
      )
    case 'spec:addDecisionComment':
      return ctx.specEngine.addDecisionComment(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as 'review' | 'implement',
        requireString(args[5])
      )
    case 'spec:resolveAnnotation':
      return ctx.specEngine.resolveAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4])
      )
    case 'spec:updateAnnotation':
      return ctx.specEngine.updateAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4]),
        requireString(args[5])
      )
    case 'spec:setContext':
      return ctx.specEngine.setContext(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as SpecContextReference[]
      )
    case 'spec:getContextAttachments': {
      const projectId = requireString(args[0])
      const current = await ctx.specEngine.getVersion(
        projectId,
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number
      )
      if (!current) throw new Error('Specification version not found')
      return ctx.specContextService.promptAttachments(projectId, current.context)
    }

    // ─── Assignment studio ──────────────────────────────────────────────
    case 'assignment:getActive':
      return ctx.assignmentEngine.getActive(requireString(args[0]), requireString(args[1]))
    case 'assignment:listVersions':
      return ctx.assignmentEngine.listVersions(requireString(args[2]))
    case 'assignment:saveDraft':
      return ctx.assignmentEngine.saveDraft(
        requireString(args[0]),
        requireString(args[1]),
        args[2] as AssignmentPlanContent,
        args[3] as Parameters<typeof ctx.assignmentEngine.saveDraft>[3]
      )
    case 'assignment:addAnnotation':
      return ctx.assignmentEngine.addAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as AddAssignmentAnnotationInput
      )
    case 'assignment:updateAnnotation':
      return ctx.assignmentEngine.updateAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4]),
        requireString(args[5])
      )
    case 'assignment:resolveAnnotation':
      return ctx.assignmentEngine.resolveAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4])
      )
    case 'assignment:updateUnlinkedWorkerModel':
      return ctx.assignmentEngine.updateUnlinkedWorkerModel(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as AssignmentModelSelection
      )
    case 'assignment:updateUnlinkedWorkerScope':
      return ctx.assignmentEngine.updateUnlinkedWorkerScope(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as ScopeChoice
      )

    // ─── Audit studio ───────────────────────────────────────────────────
    case 'audit:getActive':
      return ctx.auditEngine.getActive(requireString(args[0]), requireString(args[1]))
    case 'audit:listVersions':
      return ctx.auditEngine.listVersions(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'audit:save':
      return ctx.auditEngine.save(args[0] as Parameters<typeof ctx.auditEngine.save>[0])
    case 'audit:addAnnotation':
      return ctx.auditEngine.addAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as AddAuditAnnotationInput
      )
    case 'audit:updateAnnotation':
      return ctx.auditEngine.updateAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4]),
        requireString(args[5])
      )
    case 'audit:resolveAnnotation':
      return ctx.auditEngine.resolveAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4])
      )
    case 'audit:complete': {
      const projectId = requireString(args[0])
      const threadId = requireString(args[1])
      const assignment = ctx.assignmentEngine.getActive(projectId, threadId)
      if (
        assignment?.status === 'completed' &&
        assignment.auditCycle &&
        ['report_ready', 'available'].includes(assignment.auditCycle.status)
      ) {
        await ctx.assignmentEngine.completeAuditCycle(projectId, threadId)
        await ctx.threadManager.setStatus(projectId, threadId, 'completed')
        return ctx.threadManager.setAuditState(projectId, threadId, undefined)
      }
      const thread = await ctx.threadManager.getThread(projectId, threadId)
      if (thread && thread.status === 'spec') {
        await ctx.threadManager.setStatus(projectId, threadId, 'completed')
      }
      return ctx.threadManager.setAuditState(projectId, threadId, undefined)
    }
    case 'audit:dismiss': {
      const projectId = requireString(args[0])
      const threadId = requireString(args[1])
      const assignment = ctx.assignmentEngine.getActive(projectId, threadId)
      if (assignment?.auditCycle?.status === 'available') {
        await ctx.assignmentEngine.dismissAuditOffer(projectId, threadId)
      }
      return ctx.threadManager.setAuditState(projectId, threadId, undefined)
    }
    case 'audit:restoreOffer': {
      const projectId = requireString(args[0])
      const threadId = requireString(args[1])
      const assignment = await ctx.assignmentEngine.restoreAuditOffer(projectId, threadId)
      await ctx.threadManager.setAuditState(projectId, threadId, 'offered')
      return assignment
    }
    case 'audit:returnToOffer': {
      const projectId = requireString(args[0])
      const threadId = requireString(args[1])
      const assignment = await ctx.assignmentEngine.makeAuditAvailable(projectId, threadId)
      await ctx.threadManager.setStatus(projectId, threadId, 'spec')
      return assignment
    }

    // ─── Brainstorm studio ──────────────────────────────────────────────
    case 'engineeringLifecycle:get':
      return ctx.engineeringLifecycleEngine.get(
        validateEntityId(args[0], 'Project ID'),
        validateEntityId(args[1], 'Thread ID')
      )
    case 'engineeringLifecycle:select':
      return ctx.engineeringLifecycleEngine.select(
        validateEntityId(args[0], 'Project ID'),
        validateEntityId(args[1], 'Thread ID'),
        validateEngineeringLifecycleSelectionInput(args[2])
      )
    case 'engineeringLifecycle:start':
      return ctx.engineeringLifecycleEngine.start(
        validateEntityId(args[0], 'Project ID'),
        validateEntityId(args[1], 'Thread ID'),
        args[2] === undefined || args[2] === null
          ? undefined
          : validateEngineeringLifecycleStage(args[2])
      )
    case 'engineeringLifecycle:complete':
      return ctx.engineeringLifecycleEngine.completeStage(
        validateEntityId(args[0], 'Project ID'),
        validateEntityId(args[1], 'Thread ID'),
        validateEngineeringLifecycleStage(args[2])
      )
    case 'engineeringLifecycle:resume':
      return ctx.engineeringLifecycleEngine.resume(
        validateEntityId(args[0], 'Project ID'),
        validateEntityId(args[1], 'Thread ID'),
        validateEngineeringLifecycleResumeToken(args[2]),
        validateEngineeringLifecycleDecision(args[3])
      )
    case 'engineeringLifecycle:retry':
      return ctx.engineeringLifecycleEngine.retry(
        validateEntityId(args[0], 'Project ID'),
        validateEntityId(args[1], 'Thread ID'),
        validateEngineeringLifecycleResumeToken(args[2])
      )
    case 'engineeringLifecycle:cancel':
      if (args[2] !== true) {
        throw new TypeError('Engineering lifecycle cancellation requires confirmation')
      }
      {
        const pid = validateEntityId(args[0], 'Project ID')
        const tid = validateEntityId(args[1], 'Thread ID')
        const before = ctx.engineeringLifecycleEngine.get(pid, tid)
        const result = ctx.engineeringLifecycleEngine.cancel(pid, tid)
        // Match the desktop handler: a user-initiated stop must halt the
        // in-flight generation turn so the thread cannot be re-surfaced on
        // view switch or resumed by restart recovery.
        if (
          before &&
          (before.activeStage !== undefined ||
            before.humanGate !== undefined ||
            before.selection !== 'none')
        ) {
          await chatEngine.abort(pid, tid)
        }
        return result
      }
    case 'prd:ensureWorkflow':
      return ctx.prdEngine.ensureWorkflow(requireString(args[0]), requireString(args[1]))
    case 'prd:getWorkflow':
      return ctx.prdEngine.getWorkflowState(requireString(args[0]), requireString(args[1]))
    case 'prd:chooseEntry': {
      const choice = args[2]
      if (choice !== 'brainstorm_first' && choice !== 'start_prd') {
        throw new TypeError('Invalid PRD entry choice')
      }
      return ctx.prdEngine.chooseEntry(requireString(args[0]), requireString(args[1]), choice)
    }
    case 'prd:beginDrafting':
      return ctx.prdEngine.beginDrafting(requireString(args[0]), requireString(args[1]))
    case 'prd:getActive':
      return ctx.prdEngine.getActive(requireString(args[0]), requireString(args[1]))
    case 'prd:listVersions':
      return ctx.prdEngine.listVersions(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'prd:createDraft':
      return ctx.prdEngine.createDraft(
        requireString(args[0]),
        requireString(args[1]),
        parseGeneratedPrdContent(args[2]),
        args[3] as NewPrdProvenance
      )
    case 'prd:saveDraft':
      return ctx.prdEngine.saveDraft(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        parseGeneratedPrdContent(args[4])
      )
    case 'prd:createVersion':
      return ctx.prdEngine.createVersion(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        parseGeneratedPrdContent(args[3]),
        args[4] as NewPrdProvenance
      )
    case 'prd:addAnnotation':
      return ctx.prdEngine.addAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as AddPrdAnnotationInput
      )
    case 'prd:updateAnnotation':
      return ctx.prdEngine.updateAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4]),
        requireString(args[5])
      )
    case 'prd:resolveAnnotation':
      return ctx.prdEngine.resolveAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4])
      )
    case 'prd:finalize':
      return ctx.prdEngine.finalize(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number
      )
    case 'prd:openInEditor':
    case 'prd:revealInFiles':
      return ''
    case 'prototypePreview:getOrigin':
      return (
        resolvePrototypePreviewOrigin(process.env, {
          development: false,
          bakedOrigin: __CODEINOVEN_PROTOTYPE_PREVIEW_ORIGIN__
        }).origin ?? null
      )
    case 'brainstorm:getActive':
      return ctx.brainstormEngine.getActive(requireString(args[0]), requireString(args[1]))
    case 'brainstorm:getWorkflow':
      return ctx.brainstormEngine.getWorkflowState(requireString(args[0]), requireString(args[1]))
    case 'brainstorm:resetWorkflow':
      return ctx.brainstormEngine.resetWorkflow(requireString(args[0]), requireString(args[1]))
    case 'brainstorm:listVersions':
      return ctx.brainstormEngine.listVersions(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2])
      )
    case 'brainstorm:saveDraft':
      return ctx.brainstormEngine.saveDraft(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as BrainstormContent
      )
    case 'brainstorm:addAnnotation':
      return ctx.brainstormEngine.addAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        args[4] as AddBrainstormAnnotationInput
      )
    case 'brainstorm:updateAnnotation':
      return ctx.brainstormEngine.updateAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4]),
        requireString(args[5])
      )
    case 'brainstorm:resolveAnnotation':
      return ctx.brainstormEngine.resolveAnnotation(
        requireString(args[0]),
        requireString(args[1]),
        requireString(args[2]),
        args[3] as number,
        requireString(args[4])
      )
    default:
      return REMOTE_RPC_UNHANDLED
  }
}
