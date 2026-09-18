import { BrowserWindow, dialog } from 'electron'
import { readFile } from 'fs/promises'
import { basename } from 'path'
import { atomicWrite } from '../../../lib/utils'
import { modelKey } from '../../../lib/model-keys'
import { validateAuditReportContent } from '../../../lib/audit/audit-validation'
import { exportAuditReportMarkdown } from '../../../lib/audit/audit-markdown'
import { exportAssignmentMarkdown } from '../../../lib/assignment/assignment-markdown'
import { validateAssignment } from '../../../lib/assignment/assignment-validation'
import {
  exportEngineeringSpecMarkdown,
  importEngineeringSpecMarkdown
} from '../../../lib/spec/spec-markdown'
import { validateEngineeringSpec } from '../../../lib/spec/spec-validation'
import { parseGeneratedBrainstormContent } from '../../../lib/brainstorm/brainstorm-validation'
import { exportBrainstormMarkdown } from '../../../lib/brainstorm/brainstorm-markdown'
import { exportPrdMarkdown } from '../../../lib/prd/prd-markdown'
import { parseGeneratedPrdContent } from '../../../lib/prd/prd-validation'
import { validateBoundedInteger, validateEntityId } from '../ipc-validation'
import { isRecord, requireString, requireVersion } from './shared'
import {
  validateAnnotationInput,
  validateAssignmentAnnotationInput,
  validateAssignmentContent,
  validateAssignmentModel,
  validateAssignmentWorkerScope,
  validateAssignmentProvenance,
  validateAuditAnnotationInput,
  validateBrainstormAnnotationInput,
  validateBrainstormProvenance,
  validateContext,
  validateEngineeringSpecInput,
  validatePrdAnnotationInput,
  validatePrdProvenance,
  validateProvenance,
  validateSpecContent,
  validateSpecValidationIssue
} from './spec-helpers'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { NewSpecProvenance } from '../../../lib/engines/spec-engine'
import type {
  BrainstormEntryChoice,
  CapturableSpecContextType,
  PrdEntryChoice
} from '../../../lib/types'
import type { IpcHandlerContext } from './context'

export function registerSpecHandlers(ctx: IpcHandlerContext): void {
  const {
    storage,
    projectManager,
    projectFilesService,
    threadManager,
    specEngine,
    brainstormEngine,
    prdEngine,
    auditEngine,
    assignmentEngine,
    specContextService,
    editorService,
    memoryService,
    privileged,
    waitForThreadReady
  } = ctx

  // ─── Engineering specifications ───────────────────────────────────────
  ipcMain.handle(
    'assignment:getActive',
    async (_, projectId: unknown, coordinatorThreadId: unknown) => {
      const ids = await waitForThreadReady(
        projectId,
        coordinatorThreadId,
        'Project ID',
        'Coordinator thread ID'
      )
      return assignmentEngine.getActive(ids.projectId, ids.threadId)
    }
  )
  ipcMain.handle(
    'assignment:listVersions',
    (_, projectId: unknown, coordinatorThreadId: unknown, assignmentId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeCoordinatorThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
      const safeAssignmentId = validateEntityId(assignmentId, 'Assignment ID')
      const active = assignmentEngine.getActive(safeProjectId, safeCoordinatorThreadId)
      if (!active || active.id !== safeAssignmentId) {
        throw new Error('Assignment does not belong to this coordinator thread')
      }
      return assignmentEngine.listVersions(safeAssignmentId)
    }
  )
  ipcMain.handle(
    'assignment:saveDraft',
    (_, projectId: unknown, coordinatorThreadId: unknown, content: unknown, provenance: unknown) =>
      assignmentEngine.saveDraft(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(coordinatorThreadId, 'Coordinator thread ID'),
        validateAssignmentContent(content),
        validateAssignmentProvenance(provenance)
      )
  )
  ipcMain.handle(
    'assignment:addAnnotation',
    async (
      _,
      projectId: unknown,
      coordinatorThreadId: unknown,
      assignmentId: unknown,
      version: unknown,
      input: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
      const active = assignmentEngine.getActive(safeProjectId, safeThreadId)
      if (!active) throw new Error('Assignment not found')
      return assignmentEngine.addAnnotation(
        safeProjectId,
        safeThreadId,
        validateEntityId(assignmentId, 'Assignment ID'),
        validateBoundedInteger(version, 'Assignment version', 1, Number.MAX_SAFE_INTEGER),
        validateAssignmentAnnotationInput(input, active.content)
      )
    }
  )
  ipcMain.handle(
    'assignment:updateAnnotation',
    (
      _,
      projectId: unknown,
      coordinatorThreadId: unknown,
      assignmentId: unknown,
      version: unknown,
      annotationId: unknown,
      body: unknown
    ) =>
      assignmentEngine.updateAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(coordinatorThreadId, 'Coordinator thread ID'),
        validateEntityId(assignmentId, 'Assignment ID'),
        validateBoundedInteger(version, 'Assignment version', 1, Number.MAX_SAFE_INTEGER),
        validateEntityId(annotationId, 'Assignment annotation ID'),
        requireString(body, 'Assignment annotation')
      )
  )
  ipcMain.handle(
    'assignment:resolveAnnotation',
    (
      _,
      projectId: unknown,
      coordinatorThreadId: unknown,
      assignmentId: unknown,
      version: unknown,
      annotationId: unknown
    ) =>
      assignmentEngine.resolveAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(coordinatorThreadId, 'Coordinator thread ID'),
        validateEntityId(assignmentId, 'Assignment ID'),
        validateBoundedInteger(version, 'Assignment version', 1, Number.MAX_SAFE_INTEGER),
        validateEntityId(annotationId, 'Assignment annotation ID')
      )
  )
  ipcMain.handle(
    'assignment:updateUnlinkedWorkerModel',
    (_, projectId: unknown, coordinatorThreadId: unknown, taskId: unknown, model: unknown) => {
      const safeModel = validateAssignmentModel(model, 'Assignment worker model')
      if (!safeModel) throw new TypeError('Assignment worker model is required')
      return assignmentEngine.updateUnlinkedWorkerModel(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(coordinatorThreadId, 'Coordinator thread ID'),
        validateEntityId(taskId, 'Assignment task ID'),
        safeModel
      )
    }
  )
  ipcMain.handle(
    'assignment:updateUnlinkedWorkerScope',
    (_, projectId: unknown, coordinatorThreadId: unknown, taskId: unknown, scope: unknown) =>
      assignmentEngine.updateUnlinkedWorkerScope(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(coordinatorThreadId, 'Coordinator thread ID'),
        validateEntityId(taskId, 'Assignment task ID'),
        validateAssignmentWorkerScope(scope, 'Assignment worker scope')
      )
  )
  ipcMain.handle('assignment:validate', (_, content: unknown) =>
    validateAssignment(validateAssignmentContent(content))
  )
  privileged(
    'assignment:openInEditor',
    async (_event, projectId: unknown, coordinatorThreadId: unknown, content: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
      const active = assignmentEngine.getActive(safeProjectId, safeThreadId)
      if (!active) throw new Error('Assignment not found')
      const safeContent = validateAssignmentContent(content)
      const targetPath = await assignmentEngine.markdownPath(safeProjectId, safeThreadId)
      await atomicWrite(targetPath, exportAssignmentMarkdown({ ...active, content: safeContent }))
      const config = await storage.getConfig()
      await editorService.openInEditor(config.preferredEditor, targetPath, 'file')
      return targetPath
    }
  )
  privileged(
    'assignment:revealInFiles',
    async (_event, projectId: unknown, coordinatorThreadId: unknown, content: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(coordinatorThreadId, 'Coordinator thread ID')
      const active = assignmentEngine.getActive(safeProjectId, safeThreadId)
      if (!active) throw new Error('Assignment not found')
      const safeContent = validateAssignmentContent(content)
      const targetPath = await assignmentEngine.markdownPath(safeProjectId, safeThreadId)
      await atomicWrite(targetPath, exportAssignmentMarkdown({ ...active, content: safeContent }))
      return targetPath
    }
  )
  ipcMain.handle('brainstorm:ensureWorkflow', (_, projectId: unknown, threadId: unknown) =>
    brainstormEngine.ensureWorkflow(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle('brainstorm:getWorkflow', async (_, projectId: unknown, threadId: unknown) => {
    const ids = await waitForThreadReady(projectId, threadId)
    return brainstormEngine.getWorkflowState(ids.projectId, ids.threadId)
  })
  ipcMain.handle(
    'brainstorm:chooseEntry',
    (_, projectId: unknown, threadId: unknown, choice: unknown) => {
      if (choice !== 'brainstorm' && choice !== 'spec') {
        throw new TypeError('Brainstorm entry choice must be brainstorm or spec')
      }
      return brainstormEngine.chooseEntry(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        choice as BrainstormEntryChoice
      )
    }
  )
  ipcMain.handle('brainstorm:resetWorkflow', (_, projectId: unknown, threadId: unknown) => {
    brainstormEngine.resetWorkflow(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  })
  ipcMain.handle('brainstorm:getActive', async (_, projectId: unknown, threadId: unknown) => {
    const ids = await waitForThreadReady(projectId, threadId)
    return brainstormEngine.getActive(ids.projectId, ids.threadId)
  })
  ipcMain.handle(
    'brainstorm:listVersions',
    (_, projectId: unknown, threadId: unknown, brainstormId: unknown) =>
      brainstormEngine.listVersions(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID')
      )
  )
  ipcMain.handle(
    'brainstorm:createDraft',
    (_, projectId: unknown, threadId: unknown, content: unknown, provenance: unknown) =>
      brainstormEngine.createDraft({
        projectId: validateEntityId(projectId, 'Project ID'),
        threadId: validateEntityId(threadId, 'Thread ID'),
        content: parseGeneratedBrainstormContent(content),
        provenance: validateBrainstormProvenance(provenance)
      })
  )
  ipcMain.handle(
    'brainstorm:saveDraft',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      content: unknown
    ) =>
      brainstormEngine.saveDraft(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        parseGeneratedBrainstormContent(content)
      )
  )
  ipcMain.handle(
    'brainstorm:createVersion',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      content: unknown,
      provenance: unknown
    ) =>
      brainstormEngine.createVersion({
        projectId: validateEntityId(projectId, 'Project ID'),
        threadId: validateEntityId(threadId, 'Thread ID'),
        brainstormId: validateEntityId(brainstormId, 'Brainstorm ID'),
        content: parseGeneratedBrainstormContent(content),
        provenance: validateBrainstormProvenance(provenance)
      })
  )
  ipcMain.handle(
    'brainstorm:addAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      input: unknown
    ) =>
      brainstormEngine.addAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        validateBrainstormAnnotationInput(input)
      )
  )
  ipcMain.handle(
    'brainstorm:updateAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      annotationId: unknown,
      body: unknown
    ) =>
      brainstormEngine.updateAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Brainstorm annotation ID'),
        requireString(body, 'Brainstorm annotation body')
      )
  )
  ipcMain.handle(
    'brainstorm:resolveAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      annotationId: unknown
    ) =>
      brainstormEngine.resolveAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Brainstorm annotation ID')
      )
  )
  ipcMain.handle(
    'brainstorm:addDecisionComment',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      action: unknown,
      body: unknown
    ) => {
      if (action !== 'review' && action !== 'finalize') {
        throw new TypeError('Brainstorm decision action must be review or finalize')
      }
      return brainstormEngine.addDecisionComment(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        action,
        requireString(body, 'Brainstorm decision comment')
      )
    }
  )
  ipcMain.handle(
    'brainstorm:finalize',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown,
      note: unknown
    ) =>
      brainstormEngine.finalize(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(brainstormId, 'Brainstorm ID'),
        requireVersion(version),
        note === undefined ? '' : requireString(note, 'Brainstorm finalization note', true)
      )
  )
  privileged(
    'brainstorm:openInEditor',
    async (
      _event,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown
    ) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validBrainstormId = validateEntityId(brainstormId, 'Brainstorm ID')
      const validVersion = requireVersion(version)
      const document = brainstormEngine.getVersion(
        validProjectId,
        validThreadId,
        validBrainstormId,
        validVersion
      )
      if (!document) throw new Error('Brainstorm version not found')
      const targetPath = await brainstormEngine.markdownPath(
        validProjectId,
        validThreadId,
        validBrainstormId,
        validVersion
      )
      await atomicWrite(targetPath, exportBrainstormMarkdown(document))
      const config = await storage.getConfig()
      await editorService.openInEditor(config.preferredEditor, targetPath, 'file')
      return targetPath
    }
  )
  privileged(
    'brainstorm:revealInFiles',
    async (
      _event,
      projectId: unknown,
      threadId: unknown,
      brainstormId: unknown,
      version: unknown
    ) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validBrainstormId = validateEntityId(brainstormId, 'Brainstorm ID')
      const validVersion = requireVersion(version)
      const document = brainstormEngine.getVersion(
        validProjectId,
        validThreadId,
        validBrainstormId,
        validVersion
      )
      if (!document) throw new Error('Brainstorm version not found')
      const targetPath = await brainstormEngine.markdownPath(
        validProjectId,
        validThreadId,
        validBrainstormId,
        validVersion
      )
      await atomicWrite(targetPath, exportBrainstormMarkdown(document))
      return targetPath
    }
  )
  ipcMain.handle('prd:ensureWorkflow', (_, projectId: unknown, threadId: unknown) =>
    prdEngine.ensureWorkflow(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle('prd:getWorkflow', async (_, projectId: unknown, threadId: unknown) => {
    const ids = await waitForThreadReady(projectId, threadId)
    return prdEngine.getWorkflowState(ids.projectId, ids.threadId)
  })
  ipcMain.handle('prd:chooseEntry', (_, projectId: unknown, threadId: unknown, choice: unknown) => {
    if (choice !== 'brainstorm_first' && choice !== 'start_prd') {
      throw new TypeError('PRD entry choice must be brainstorm_first or start_prd')
    }
    return prdEngine.chooseEntry(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      choice as PrdEntryChoice
    )
  })
  ipcMain.handle('prd:beginDrafting', (_, projectId: unknown, threadId: unknown) =>
    prdEngine.beginDrafting(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  )
  ipcMain.handle('prd:getActive', async (_, projectId: unknown, threadId: unknown) => {
    const ids = await waitForThreadReady(projectId, threadId)
    return prdEngine.getActive(ids.projectId, ids.threadId)
  })
  ipcMain.handle('prd:listVersions', (_, projectId: unknown, threadId: unknown, prdId: unknown) =>
    prdEngine.listVersions(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      validateEntityId(prdId, 'PRD ID')
    )
  )
  ipcMain.handle(
    'prd:createDraft',
    (_, projectId: unknown, threadId: unknown, content: unknown, provenance: unknown) =>
      prdEngine.createDraft(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        parseGeneratedPrdContent(content),
        validatePrdProvenance(provenance)
      )
  )
  ipcMain.handle(
    'prd:saveDraft',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      prdId: unknown,
      version: unknown,
      content: unknown
    ) =>
      prdEngine.saveDraft(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(prdId, 'PRD ID'),
        requireVersion(version),
        parseGeneratedPrdContent(content)
      )
  )
  ipcMain.handle(
    'prd:createVersion',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      prdId: unknown,
      content: unknown,
      provenance: unknown
    ) =>
      prdEngine.createVersion(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(prdId, 'PRD ID'),
        parseGeneratedPrdContent(content),
        validatePrdProvenance(provenance)
      )
  )
  ipcMain.handle(
    'prd:addAnnotation',
    (_, projectId: unknown, threadId: unknown, prdId: unknown, version: unknown, input: unknown) =>
      prdEngine.addAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(prdId, 'PRD ID'),
        requireVersion(version),
        validatePrdAnnotationInput(input)
      )
  )
  ipcMain.handle(
    'prd:updateAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      prdId: unknown,
      version: unknown,
      annotationId: unknown,
      body: unknown
    ) =>
      prdEngine.updateAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(prdId, 'PRD ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'PRD annotation ID'),
        requireString(body, 'PRD annotation body')
      )
  )
  ipcMain.handle(
    'prd:resolveAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      prdId: unknown,
      version: unknown,
      annotationId: unknown
    ) =>
      prdEngine.resolveAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(prdId, 'PRD ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'PRD annotation ID')
      )
  )
  ipcMain.handle(
    'prd:finalize',
    (_, projectId: unknown, threadId: unknown, prdId: unknown, version: unknown) =>
      prdEngine.finalize(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(prdId, 'PRD ID'),
        requireVersion(version)
      )
  )
  const preparePrdMarkdown = async (
    projectId: unknown,
    threadId: unknown,
    prdId: unknown,
    version: unknown
  ): Promise<string> => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeThreadId = validateEntityId(threadId, 'Thread ID')
    const safePrdId = validateEntityId(prdId, 'PRD ID')
    const safeVersion = requireVersion(version)
    const document = prdEngine.getVersion(safeProjectId, safeThreadId, safePrdId, safeVersion)
    if (!document) throw new Error('PRD version not found')
    const targetPath = await prdEngine.markdownPath(
      safeProjectId,
      safeThreadId,
      safePrdId,
      safeVersion
    )
    await atomicWrite(targetPath, exportPrdMarkdown(document))
    return targetPath
  }
  privileged(
    'prd:openInEditor',
    async (_event, projectId: unknown, threadId: unknown, prdId: unknown, version: unknown) => {
      const targetPath = await preparePrdMarkdown(projectId, threadId, prdId, version)
      const config = await storage.getConfig()
      await editorService.openInEditor(config.preferredEditor, targetPath, 'file')
      return targetPath
    }
  )
  privileged(
    'prd:revealInFiles',
    async (_event, projectId: unknown, threadId: unknown, prdId: unknown, version: unknown) =>
      preparePrdMarkdown(projectId, threadId, prdId, version)
  )
  ipcMain.handle('spec:getActive', async (_, projectId: unknown, threadId: unknown) => {
    const { projectId: safeProjectId, threadId: safeThreadId } = await waitForThreadReady(
      projectId,
      threadId
    )
    const workflow = await specEngine.getWorkflowState(safeProjectId, safeThreadId)
    if (!workflow?.activeSpecId || !workflow.activeSpecVersion) return null
    return specEngine.getVersion(
      safeProjectId,
      safeThreadId,
      workflow.activeSpecId,
      workflow.activeSpecVersion
    )
  })
  ipcMain.handle('spec:listVersions', (_, projectId: unknown, threadId: unknown, specId: unknown) =>
    specEngine.listVersions(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      validateEntityId(specId, 'Specification ID')
    )
  )
  ipcMain.handle(
    'spec:createDraft',
    (_, projectId: unknown, threadId: unknown, content: unknown, provenance: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeContent = validateSpecContent(content)
      const safeProvenance = validateProvenance(provenance)
      return threadManager.getThread(safeProjectId, safeThreadId).then((thread) => {
        const activeModelKey =
          thread?.settings?.harnessId && thread.settings.providerId && thread.settings.modelId
            ? modelKey(
                thread.settings.harnessId,
                thread.settings.providerId,
                thread.settings.modelId
              )
            : undefined
        return memoryService
          .snapshotCurrent(safeProjectId, safeThreadId, activeModelKey)
          .then((context) =>
            specEngine.createDraft({
              projectId: safeProjectId,
              threadId: safeThreadId,
              content: safeContent,
              provenance: safeProvenance,
              context
            })
          )
      })
    }
  )
  ipcMain.handle(
    'spec:saveDraft',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      content: unknown
    ) =>
      specEngine.saveDraft(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateSpecContent(content)
      )
  )
  ipcMain.handle(
    'spec:createVersion',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      content: unknown,
      provenance: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeSpecId = validateEntityId(specId, 'Specification ID')
      const safeContent = validateSpecContent(content)
      const safeProvenance = validateProvenance(provenance)
      return threadManager.getThread(safeProjectId, safeThreadId).then((thread) => {
        const activeModelKey =
          thread?.settings?.harnessId && thread.settings.providerId && thread.settings.modelId
            ? modelKey(
                thread.settings.harnessId,
                thread.settings.providerId,
                thread.settings.modelId
              )
            : undefined
        return Promise.all([
          specEngine.getLatest(safeProjectId, safeThreadId, safeSpecId),
          memoryService.snapshotCurrent(safeProjectId, safeThreadId, activeModelKey)
        ]).then(([latest, memory]) =>
          specEngine.createVersion({
            projectId: safeProjectId,
            threadId: safeThreadId,
            specId: safeSpecId,
            content: safeContent,
            provenance: safeProvenance,
            context: [
              ...(latest?.context.filter((reference) => reference.type !== 'memory') ?? []),
              ...memory
            ]
          })
        )
      })
    }
  )
  ipcMain.handle(
    'spec:dismissValidationIssue',
    (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown, issue: unknown) =>
      specEngine.dismissValidationIssue(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateSpecValidationIssue(issue)
      )
  )
  ipcMain.handle(
    'spec:setReview',
    (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown) =>
      specEngine.setReview(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version)
      )
  )
  ipcMain.handle(
    'spec:approve',
    (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown) =>
      specEngine.approve(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version)
      )
  )
  ipcMain.handle('spec:validate', (_, spec: unknown) =>
    validateEngineeringSpec(validateEngineeringSpecInput(spec))
  )
  ipcMain.handle('audit:getActive', async (_, projectId: unknown, threadId: unknown) => {
    const ids = await waitForThreadReady(projectId, threadId)
    return auditEngine.getActive(ids.projectId, ids.threadId)
  })
  ipcMain.handle(
    'audit:listVersions',
    (_, projectId: unknown, threadId: unknown, reportId: unknown) =>
      auditEngine.listVersions(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(reportId, 'Audit report ID')
      )
  )
  ipcMain.handle('audit:save', async (_, report: unknown, content: unknown) => {
    if (!isRecord(report)) throw new TypeError('Audit report must be an object')
    const projectId = validateEntityId(report.projectId, 'Project ID')
    const threadId = validateEntityId(report.threadId, 'Thread ID')
    const reportId = validateEntityId(report.id, 'Audit report ID')
    const version = requireVersion(report.version)
    const persisted = (await auditEngine.listVersions(projectId, threadId, reportId)).find(
      (candidate) => candidate.version === version
    )
    if (!persisted) throw new Error(`Audit report not found: ${reportId} v${version}`)
    return auditEngine.save({
      ...persisted,
      content: validateAuditReportContent(content)
    })
  })
  ipcMain.handle(
    'audit:addAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      reportId: unknown,
      version: unknown,
      input: unknown
    ) =>
      auditEngine.addAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(reportId, 'Audit report ID'),
        requireVersion(version),
        validateAuditAnnotationInput(input)
      )
  )
  ipcMain.handle(
    'audit:updateAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      reportId: unknown,
      version: unknown,
      annotationId: unknown,
      body: unknown
    ) =>
      auditEngine.updateAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(reportId, 'Audit report ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Audit annotation ID'),
        requireString(body, 'Audit annotation')
      )
  )
  ipcMain.handle(
    'audit:resolveAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      reportId: unknown,
      version: unknown,
      annotationId: unknown
    ) =>
      auditEngine.resolveAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(reportId, 'Audit report ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Audit annotation ID')
      )
  )
  ipcMain.handle('audit:complete', async (_, projectId: unknown, threadId: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    const assignment = assignmentEngine.getActive(validProjectId, validThreadId)
    if (
      assignment?.status === 'completed' &&
      assignment.auditCycle &&
      ['report_ready', 'available'].includes(assignment.auditCycle.status)
    ) {
      await assignmentEngine.completeAuditCycle(validProjectId, validThreadId)
      await threadManager.setStatus(validProjectId, validThreadId, 'completed')
      return threadManager.setAuditState(validProjectId, validThreadId, undefined)
    }
    // Non-assignment implementation audits settle the coordinator on `spec`
    // while the report is under review. Accepting the report ends the audit
    // cycle, so the thread must land on `completed` instead of staying on
    // "Spec ready" (which also keeps it out of the done slice and blocks
    // thread cleanup). Guarded so an actively working thread is never clobbered.
    const thread = await threadManager.getThread(validProjectId, validThreadId)
    if (thread && thread.status === 'spec') {
      await threadManager.setStatus(validProjectId, validThreadId, 'completed')
    }
    return threadManager.setAuditState(validProjectId, validThreadId, undefined)
  })
  ipcMain.handle('audit:dismiss', (_, projectId: unknown, threadId: unknown) =>
    threadManager.setAuditState(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      undefined
    )
  )
  ipcMain.handle('audit:beginRework', (_, projectId: unknown, threadId: unknown) =>
    threadManager.setAuditState(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      'reworking'
    )
  )
  ipcMain.handle('audit:returnToOffer', async (_, projectId: unknown, threadId: unknown) => {
    const validProjectId = validateEntityId(projectId, 'Project ID')
    const validThreadId = validateEntityId(threadId, 'Thread ID')
    const assignment = await assignmentEngine.makeAuditAvailable(validProjectId, validThreadId)
    await threadManager.setStatus(validProjectId, validThreadId, 'spec')
    await threadManager.setAuditState(validProjectId, validThreadId, 'offered')
    return assignment
  })
  privileged(
    'audit:openInEditor',
    async (_event, projectId: unknown, threadId: unknown, reportId: unknown, version: unknown) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validReportId = validateEntityId(reportId, 'Audit report ID')
      const validVersion = requireVersion(version)
      const report = auditEngine.getVersion(
        validProjectId,
        validThreadId,
        validReportId,
        validVersion
      )
      if (!report) throw new Error('Audit report version not found')
      const targetPath = await auditEngine.markdownPath(
        validProjectId,
        validThreadId,
        validReportId,
        validVersion
      )
      await atomicWrite(targetPath, exportAuditReportMarkdown(report))
      const config = await storage.getConfig()
      await editorService.openInEditor(config.preferredEditor, targetPath, 'file')
      return targetPath
    }
  )
  privileged(
    'audit:revealInFiles',
    async (_event, projectId: unknown, threadId: unknown, reportId: unknown, version: unknown) => {
      const validProjectId = validateEntityId(projectId, 'Project ID')
      const validThreadId = validateEntityId(threadId, 'Thread ID')
      const validReportId = validateEntityId(reportId, 'Audit report ID')
      const validVersion = requireVersion(version)
      const report = auditEngine.getVersion(
        validProjectId,
        validThreadId,
        validReportId,
        validVersion
      )
      if (!report) throw new Error('Audit report version not found')
      const targetPath = await auditEngine.markdownPath(
        validProjectId,
        validThreadId,
        validReportId,
        validVersion
      )
      await atomicWrite(targetPath, exportAuditReportMarkdown(report))
      return targetPath
    }
  )
  ipcMain.handle(
    'spec:addAnnotation',
    (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown, input: unknown) =>
      specEngine.addAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateAnnotationInput(input)
      )
  )
  ipcMain.handle(
    'spec:addDecisionComment',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      action: unknown,
      body: unknown
    ) => {
      if (action !== 'review' && action !== 'implement') {
        throw new TypeError('Specification decision action must be review or implement')
      }
      return specEngine.addDecisionComment(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        action,
        requireString(body, 'Specification decision comment')
      )
    }
  )
  ipcMain.handle(
    'spec:resolveAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      annotationId: unknown
    ) =>
      specEngine.resolveAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Annotation ID')
      )
  )
  ipcMain.handle(
    'spec:updateAnnotation',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      annotationId: unknown,
      body: unknown
    ) =>
      specEngine.updateAnnotation(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateEntityId(annotationId, 'Annotation ID'),
        requireString(body, 'Annotation body')
      )
  )
  ipcMain.handle(
    'spec:setContext',
    (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      context: unknown
    ) =>
      specEngine.setContext(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version),
        validateContext(context)
      )
  )
  ipcMain.handle(
    'spec:captureContext',
    async (
      _,
      projectId: unknown,
      threadId: unknown,
      specId: unknown,
      version: unknown,
      type: unknown,
      selectedPath?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeSpecId = validateEntityId(specId, 'Specification ID')
      const safeVersion = requireVersion(version)
      if (type !== 'project_file' && type !== 'project_rule' && type !== 'attachment') {
        throw new TypeError('Invalid specification context type')
      }
      const safeType: CapturableSpecContextType = type

      const current = await specEngine.getVersion(
        safeProjectId,
        safeThreadId,
        safeSpecId,
        safeVersion
      )
      if (!current) throw new Error('Specification version not found')

      const project = await projectManager.getProject(safeProjectId)
      if (!project) throw new Error(`Project not found: ${safeProjectId}`)

      let sourcePath: string
      if (selectedPath !== undefined) {
        const requestedPath = requireString(selectedPath, 'Selected context path')
        sourcePath =
          safeType === 'attachment'
            ? requestedPath
            : await projectFilesService.resolveForExternalEditor(safeProjectId, requestedPath)
      } else {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
        if (win && !win.isFocused()) win.focus()
        const options: Electron.OpenDialogOptions = {
          title:
            safeType === 'attachment'
              ? 'Attach Context File'
              : safeType === 'project_rule'
                ? 'Select Project Rule'
                : 'Select Project File',
          properties: ['openFile'],
          ...(safeType !== 'attachment' && project.path ? { defaultPath: project.path } : {})
        }
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) return null
        sourcePath = result.filePaths[0]
      }

      const reference = await specContextService.capture(safeProjectId, sourcePath, safeType)
      const duplicate =
        reference.path !== undefined &&
        current.context.some(
          (candidate) => candidate.type === reference.type && candidate.path === reference.path
        )
      if (duplicate) return current
      return specEngine.setContext(safeProjectId, safeThreadId, safeSpecId, safeVersion, [
        ...current.context,
        reference
      ])
    }
  )
  ipcMain.handle(
    'spec:getContextAttachments',
    async (_, projectId: unknown, threadId: unknown, specId: unknown, version: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const current = await specEngine.getVersion(
        safeProjectId,
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(specId, 'Specification ID'),
        requireVersion(version)
      )
      if (!current) throw new Error('Specification version not found')
      return specContextService.promptAttachments(safeProjectId, current.context)
    }
  )
  ipcMain.handle(
    'spec:importMarkdown',
    async (_, projectId: unknown, threadId: unknown, specId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      const safeSpecId =
        specId === undefined ? undefined : validateEntityId(specId, 'Specification ID')
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
      const options: Electron.OpenDialogOptions = {
        title: 'Import Engineering Specification',
        properties: ['openFile'],
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null

      const selectedPath = result.filePaths[0]
      const imported = importEngineeringSpecMarkdown(
        await readFile(selectedPath, { encoding: 'utf-8' })
      )
      const provenance: NewSpecProvenance = {
        source: 'markdown_import',
        actor: 'user',
        importedFilename: basename(selectedPath)
      }
      return safeSpecId
        ? await specEngine.createVersion({
            projectId: safeProjectId,
            threadId: safeThreadId,
            specId: safeSpecId,
            content: imported.content,
            provenance
          })
        : await specEngine.createDraft({
            projectId: safeProjectId,
            threadId: safeThreadId,
            content: imported.content,
            provenance
          })
    }
  )
  ipcMain.handle('spec:exportMarkdown', async (_, rawSpec: unknown) => {
    const spec = validateEngineeringSpecInput(rawSpec)
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
    const options: Electron.SaveDialogOptions = {
      title: 'Export Engineering Specification',
      defaultPath: `${spec.id}-v${spec.version}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await atomicWrite(result.filePath, exportEngineeringSpecMarkdown(spec))
    return result.filePath
  })
  privileged('spec:openInEditor', async (_event, rawSpec: unknown) => {
    const spec = validateEngineeringSpecInput(rawSpec)
    const persisted = await specEngine.getVersion(
      spec.projectId,
      spec.threadId,
      spec.id,
      spec.version
    )
    if (!persisted) throw new Error('Specification version not found')
    const targetPath = await specEngine.markdownPath(
      spec.projectId,
      spec.threadId,
      spec.id,
      spec.version
    )
    await atomicWrite(targetPath, exportEngineeringSpecMarkdown(spec))
    const config = await storage.getConfig()
    await editorService.openInEditor(config.preferredEditor, targetPath, 'file')
    return targetPath
  })
  privileged('spec:revealInFiles', async (_event, rawSpec: unknown) => {
    const spec = validateEngineeringSpecInput(rawSpec)
    const persisted = await specEngine.getVersion(
      spec.projectId,
      spec.threadId,
      spec.id,
      spec.version
    )
    if (!persisted) throw new Error('Specification version not found')
    const targetPath = await specEngine.markdownPath(
      spec.projectId,
      spec.threadId,
      spec.id,
      spec.version
    )
    await atomicWrite(targetPath, exportEngineeringSpecMarkdown(spec))
    return targetPath
  })
}
