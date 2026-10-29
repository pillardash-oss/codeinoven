import { scopeState } from '$lib/stores/scope.svelte'
import { invoke } from '$lib/ipc.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import type {
  Thread,
  EngineeringSpec,
  AssignmentPlan,
  AssignmentPlanContent,
  AssignmentModelSelection,
  ScopeChoice,
  AuditReport,
  SpecDecisionAction
} from '$shared/types'
import { hasSelectedStage } from '$shared/engines/engineering-lifecycle-engine'
import { workflowActionPresentation } from '$shared/workflow-action-presentation'
import { specActionLabel } from '../thread-message-presentation'
import type { ThreadView } from './ThreadView-board.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewSubmitSpecDecision {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root)
      throw new Error('ThreadViewSubmitSpecDecision read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
  }
  showSpecStudio = $state(false)

  assignment = $state<AssignmentPlan | null>(null)

  assignmentVersions = $state<AssignmentPlan[]>([])

  selectedAssignmentVersion = $state<number | undefined>()

  assignmentBusy = $state(false)

  assignmentError = $state('')

  // Intentional mounted-thread snapshot; live changes are reconciled from persisted thread state.
  // svelte-ignore state_referenced_locally
  auditState = $state<Thread['auditState']>(this.root.handleAgentEvent.thread.auditState)

  auditBusy = $state(false)

  auditReportActionsAvailable = $derived.by(() => {
    const report = this.root.contextUsage.auditReport
    if (!report) return false
    if (!this.assignment) return this.auditState === 'report_ready'
    return (
      ['completed', 'running'].includes(this.assignment.status) &&
      this.assignment.auditCycle !== undefined &&
      this.assignment.auditCycle.status === 'report_ready' &&
      this.assignment.auditCycle.reportId === report.id &&
      this.assignment.auditCycle.reportVersion === report.version
    )
  })

  async saveAssignment(content: AssignmentPlanContent): Promise<boolean> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      this.assignment = await invoke(
        'assignment:saveDraft',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        content,
        {
          source: 'manual',
          actor: 'user',
          harnessId: this.root.loadOlderMessages.settings.harnessId,
          providerId: this.root.loadOlderMessages.settings.providerId,
          modelId: this.root.loadOlderMessages.settings.modelId
        }
      )
      this.assignmentVersions = await invoke(
        'assignment:listVersions',
        this.assignment.projectId,
        this.assignment.coordinatorThreadId,
        this.assignment.id
      )
      this.selectedAssignmentVersion = this.assignment.version
      this.root.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:get',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      return true
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment draft could not be saved.'
      return false
    } finally {
      this.assignmentBusy = false
    }
  }

  applyAnnotatedAssignment(updated: AssignmentPlan): AssignmentPlan {
    this.assignment = updated
    this.assignmentVersions = this.assignmentVersions.map((candidate) =>
      candidate.id === updated.id && candidate.version === updated.version ? updated : candidate
    )
    return updated
  }

  async addAssignmentAnnotation(
    section: string,
    body: string,
    anchor: { quote: string; startOffset: number; endOffset: number }
  ): Promise<AssignmentPlan | null> {
    const current = this.assignment
    if (!current) return null
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      return this.applyAnnotatedAssignment(
        await invoke(
          'assignment:addAnnotation',
          current.projectId,
          current.coordinatorThreadId,
          current.id,
          current.version,
          { section, body, author: 'user', ...anchor }
        )
      )
    } catch (error) {
      this.assignmentError = error instanceof Error ? error.message : 'Adding the comment failed.'
      return null
    } finally {
      this.assignmentBusy = false
    }
  }

  async updateAssignmentAnnotation(
    annotationId: string,
    body: string
  ): Promise<AssignmentPlan | null> {
    const current = this.assignment
    if (!current) return null
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      return this.applyAnnotatedAssignment(
        await invoke(
          'assignment:updateAnnotation',
          current.projectId,
          current.coordinatorThreadId,
          current.id,
          current.version,
          annotationId,
          body
        )
      )
    } catch (error) {
      this.assignmentError = error instanceof Error ? error.message : 'Updating the comment failed.'
      return null
    } finally {
      this.assignmentBusy = false
    }
  }

  async resolveAssignmentAnnotation(annotationId: string): Promise<AssignmentPlan | null> {
    const current = this.assignment
    if (!current) return null
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      return this.applyAnnotatedAssignment(
        await invoke(
          'assignment:resolveAnnotation',
          current.projectId,
          current.coordinatorThreadId,
          current.id,
          current.version,
          annotationId
        )
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'Resolving the comment failed.'
      return null
    } finally {
      this.assignmentBusy = false
    }
  }

  async updateAssignmentTaskModel(
    taskId: string,
    selection: AssignmentModelSelection
  ): Promise<void> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      this.assignment = await invoke(
        'assignment:updateUnlinkedWorkerModel',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        taskId,
        selection
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The task model could not be updated.'
    } finally {
      this.assignmentBusy = false
    }
  }

  async updateAssignmentTaskScope(taskId: string, scope: ScopeChoice): Promise<void> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      this.assignment = await invoke(
        'assignment:updateUnlinkedWorkerScope',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        taskId,
        scope
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The task scope could not be updated.'
    } finally {
      this.assignmentBusy = false
    }
  }

  /**
   * Move every worker of a signed-off Assignment that has no scope of its own.
   * The choice is a request: a dedicated worktree is created at dispatch, so this
   * stays instant however many tasks the Assignment carries.
   */
  async updateAssignmentWorkerScope(scope: ScopeChoice): Promise<void> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      this.assignment = await invoke(
        'assignment:updateWorkerScope',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        scope
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The worker scope could not be updated.'
    } finally {
      this.assignmentBusy = false
    }
  }

  async approveAssignment(content: AssignmentPlanContent): Promise<void> {
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      await this.root.sources.assignmentSeniorSettingsPersistence
      if (!this.assignment || JSON.stringify(this.assignment.content) !== JSON.stringify(content)) {
        this.assignment = await invoke(
          'assignment:saveDraft',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          content,
          {
            source: 'manual',
            actor: 'user',
            harnessId: this.root.loadOlderMessages.settings.harnessId,
            providerId: this.root.loadOlderMessages.settings.providerId,
            modelId: this.root.loadOlderMessages.settings.modelId
          }
        )
      }
      if (
        this.root.handleAgentEvent.engineeringLifecycle?.humanGate === 'assignment_approval' &&
        this.root.handleAgentEvent.engineeringLifecycle.resumeToken
      ) {
        this.root.handleAgentEvent.engineeringLifecycle = (
          await invoke(
            'engineeringLifecycle:resume',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id,
            this.root.handleAgentEvent.engineeringLifecycle.resumeToken,
            'continue'
          )
        ).state
      }
      this.assignment = await invoke(
        'agent:startAssignment',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      if (
        this.root.handleAgentEvent.engineeringLifecycle?.autopilot &&
        this.root.handleAgentEvent.engineeringLifecycle.activeStage === 'assignment'
      ) {
        this.root.handleAgentEvent.engineeringLifecycle = await invoke(
          'engineeringLifecycle:complete',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          'assignment'
        )
      }
      this.assignmentVersions = await invoke(
        'assignment:listVersions',
        this.assignment.projectId,
        this.assignment.coordinatorThreadId,
        this.assignment.id
      )
      this.selectedAssignmentVersion = this.assignment.version
      this.root.studioTemporaryChatContext.specReadyToolVisible = false
      this.root.loadOlderMessages.settings = this.root.handleAgentEvent.engineeringLifecycle
        ?.autopilot
        ? {
            ...this.root.loadOlderMessages.settings,
            assignmentMode: true,
            loopMode: true
          }
        : {
            ...this.root.loadOlderMessages.settings,
            assignmentMode: false
          }
      this.root.sources.commitSettings(this.root.loadOlderMessages.settings)
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment could not be started.'
    } finally {
      this.assignmentBusy = false
    }
  }

  /**
   * Generate the Assignment draft. An active Spec is approved in place first so
   * the explicit "Generate Assignment" action never fails on an unapproved Spec;
   * without any Spec the main process decomposes the supplied conversation
   * instead, which is why `instructions` can carry the user's own request.
   */
  async generateAssignmentDraft(instructions?: string): Promise<void> {
    if (this.assignmentBusy) return
    this.assignmentBusy = true
    this.root.composerScope.assignmentFormulating = true
    this.assignmentError = ''
    try {
      let signingSpec = this.root.submitBrainstormDecision.spec
      if (signingSpec) {
        if (signingSpec.status === 'draft') {
          signingSpec = await invoke(
            'spec:setReview',
            signingSpec.projectId,
            signingSpec.threadId,
            signingSpec.id,
            signingSpec.version
          )
          this.root.submitBrainstormDecision.spec = signingSpec
        }
        if (signingSpec.status === 'in_review') {
          signingSpec = await invoke(
            'spec:approve',
            signingSpec.projectId,
            signingSpec.threadId,
            signingSpec.id,
            signingSpec.version
          )
          await this.root.harnessUsage.setActiveSpec(signingSpec)
        }
      }
      this.assignment = await invoke(
        'agent:generateAssignmentDraft',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        this.root.loadOlderMessages.settings,
        instructions && instructions.trim() ? instructions : undefined
      )
      this.assignmentVersions = await invoke(
        'assignment:listVersions',
        this.assignment.projectId,
        this.assignment.coordinatorThreadId,
        this.assignment.id
      )
      this.selectedAssignmentVersion = this.assignment.version
      this.root.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:get',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      this.root.studioTemporaryChatContext.specReadyToolVisible = false
      this.root.harnessUsage.studioDocument = 'assignment'
      this.showSpecStudio = true
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment could not be generated.'
      this.root.handleAgentEvent.errorMessage = this.assignmentError
    } finally {
      this.assignmentBusy = false
      this.root.composerScope.assignmentFormulating = false
    }
  }

  openAssignmentStudio(): void {
    if (!this.assignment) return
    this.selectedAssignmentVersion = this.assignment.version
    this.root.currentWorkingTraceAttribution.assignmentFocusTaskId = undefined
    workspaceState.specAgentSidebarOpen = false
    this.root.harnessUsage.studioDocument = 'assignment'
    this.showSpecStudio = true
  }

  resumeAssignmentCoordination(): void {
    const current = this.assignment
    if (!current || this.assignmentBusy) return
    this.assignmentBusy = true
    this.assignmentError = ''
    const clearBubbledCoordinatorError =
      this.root.submitBrainstormDecision.coordinatorErrorMatchesAssignmentWorker
    void invoke('agent:resumeAssignmentAttention', current.projectId, current.coordinatorThreadId)
      .then(async (updated) => {
        this.assignment = updated
        if (clearBubbledCoordinatorError) {
          this.root.handleAgentEvent.errorMessage = ''
          this.root.handleAgentEvent.providerStatus = null
        }
        await this.root.submitBrainstormDecision.reconcileReadySpec()
      })
      .catch((error) => {
        this.assignmentError =
          error instanceof Error ? error.message : 'Assignment coordination could not resume.'
        this.root.handleAgentEvent.errorMessage = this.assignmentError
      })
      .finally(() => {
        this.assignmentBusy = false
      })
  }

  async stopAssignment(): Promise<void> {
    const current = this.assignment
    if (!current || this.assignmentBusy) return
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      const stoppedAssignment = await invoke(
        'agent:stopAssignment',
        current.projectId,
        current.coordinatorThreadId
      )
      this.assignment = stoppedAssignment
      this.assignmentVersions = this.assignmentVersions.map((candidate) =>
        candidate.id === stoppedAssignment.id && candidate.version === stoppedAssignment.version
          ? stoppedAssignment
          : candidate
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment could not be stopped.'
      throw error
    } finally {
      this.assignmentBusy = false
    }
  }

  async resumeStoppedAssignment(): Promise<void> {
    const current = this.assignment
    if (!current || this.assignmentBusy) return
    this.assignmentBusy = true
    this.assignmentError = ''
    try {
      const resumedAssignment = await invoke(
        'agent:resumeAssignment',
        current.projectId,
        current.coordinatorThreadId
      )
      this.assignment = resumedAssignment
      this.assignmentVersions = this.assignmentVersions.map((candidate) =>
        candidate.id === resumedAssignment.id && candidate.version === resumedAssignment.version
          ? resumedAssignment
          : candidate
      )
    } catch (error) {
      this.assignmentError =
        error instanceof Error ? error.message : 'The Assignment could not be resumed.'
      throw error
    } finally {
      this.assignmentBusy = false
    }
  }

  /** `complete` accepts the audit cycle (thread lands on Done); `dismiss`
   *  cancels the offer/report card without ending the audit cycle. */
  async completeAudit(outcome: 'complete' | 'dismiss' = 'complete'): Promise<void> {
    this.auditBusy = true
    try {
      const updatedThread = await invoke(
        outcome === 'dismiss' ? 'audit:dismiss' : 'audit:complete',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      scopeState.updateThread(updatedThread)
      if (outcome === 'complete') {
        if (this.assignment) {
          const coordinatorThreadId = this.auditWorkflowThreadId()
          const refreshedAssignment = await invoke(
            'assignment:getActive',
            this.root.handleAgentEvent.thread.projectId,
            coordinatorThreadId
          ).catch(() => null)
          if (refreshedAssignment) this.assignment = refreshedAssignment
        }
        if (this.root.handleAgentEvent.engineeringLifecycle?.activeStage === 'achievement') {
          this.root.handleAgentEvent.engineeringLifecycle = await invoke(
            'engineeringLifecycle:complete',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id,
            'achievement'
          )
        }
        this.root.loadOlderMessages.settings = {
          ...this.root.loadOlderMessages.settings,
          loopMode: false
        }
        this.root.sources.commitSettings(this.root.loadOlderMessages.settings)
        await invoke(
          'thread:updateSettings',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          this.root.loadOlderMessages.settings
        )
      } else if (this.assignment) {
        // Dismissing an Assignment offer lands on the plan, so refresh it here
        // or the composer card would stay up until the next reconcile.
        const refreshedAssignment = await invoke(
          'assignment:getActive',
          this.root.handleAgentEvent.thread.projectId,
          this.auditWorkflowThreadId()
        ).catch(() => null)
        if (refreshedAssignment) this.assignment = refreshedAssignment
      }
      this.auditState = undefined
      await this.root.submitBrainstormDecision.reconcileReadySpec()
      this.showSpecStudio = false
      this.root.harnessUsage.studioDocument = 'spec'
    } catch (error) {
      this.root.buildSpecActionPrompt.auditError =
        error instanceof Error ? error.message : 'The feature could not be completed.'
    } finally {
      this.auditBusy = false
    }
  }

  auditWorkflowThreadId(): string {
    return (
      this.assignment?.coordinatorThreadId ??
      this.root.handleAgentEvent.thread.coordinatorThreadId ??
      this.root.handleAgentEvent.thread.id
    )
  }

  async reviewAudit(report: AuditReport, notes: string): Promise<boolean> {
    if (this.auditBusy) return false
    this.auditBusy = true
    this.root.buildSpecActionPrompt.auditError = ''
    try {
      const coordinatorThreadId = this.auditWorkflowThreadId()
      const currentAssignment = await invoke(
        'assignment:getActive',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId
      )
      this.assignment = currentAssignment
      if (!currentAssignment) {
        const updatedCoordinator = await invoke(
          'agent:submitAchievementAuditFeedback',
          this.root.handleAgentEvent.thread.projectId,
          coordinatorThreadId,
          report.id,
          report.version,
          notes
        )
        scopeState.updateThread(updatedCoordinator)
        this.auditState = 'reworking'
        workspaceState.specAgentSidebarOpen = false
        this.showSpecStudio = false
        return true
      }
      if (
        !['completed', 'running'].includes(currentAssignment.status) ||
        !currentAssignment.auditCycle ||
        !['report_ready', 'planning_rework'].includes(currentAssignment.auditCycle.status) ||
        currentAssignment.auditCycle.reportId !== report.id ||
        currentAssignment.auditCycle.reportVersion !== report.version
      ) {
        this.root.buildSpecActionPrompt.auditError =
          currentAssignment?.auditCycle?.status === 'running'
            ? 'The auditor is still working. Review will be available when the report is ready.'
            : 'This historical audit report is read-only. Open the current report to submit feedback.'
        return false
      }
      this.assignment = await invoke(
        'agent:submitAssignmentAuditFeedback',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        report.id,
        report.version,
        notes
      )
      this.assignmentVersions = await invoke(
        'assignment:listVersions',
        this.assignment.projectId,
        this.assignment.coordinatorThreadId,
        this.assignment.id
      )
      this.selectedAssignmentVersion = this.assignment.version
      this.auditState = 'reworking'
      workspaceState.specAgentSidebarOpen = false
      this.showSpecStudio = false
      return true
    } catch (error) {
      this.root.buildSpecActionPrompt.auditError =
        error instanceof Error ? error.message : 'The Sr. Engineer could not receive the feedback.'
      return false
    } finally {
      this.auditBusy = false
    }
  }

  async submitSpecDecision(
    action: SpecDecisionAction,
    draft: EngineeringSpec,
    notes: string
  ): Promise<void> {
    this.showSpecStudio = false
    if (action === 'implement') {
      this.root.studioTemporaryChatContext.specReadyToolVisible = false
    }
    try {
      let active = draft
      const decisionComment = notes.trim()
      if (decisionComment) {
        active = await invoke(
          'spec:addDecisionComment',
          active.projectId,
          active.threadId,
          active.id,
          active.version,
          action,
          decisionComment
        )
        await this.root.harnessUsage.setActiveSpec(active)
      }
      if (action === 'implement') {
        const lifecycleSpecApproval =
          (this.root.handleAgentEvent.engineeringLifecycle?.activeStage === 'spec' ||
            this.root.handleAgentEvent.engineeringLifecycle?.humanGate === 'spec_approval') &&
          (hasSelectedStage(this.root.handleAgentEvent.engineeringLifecycle, 'spec') ||
            this.root.handleAgentEvent.engineeringLifecycle?.autopilot)
        if (lifecycleSpecApproval) {
          if (
            this.root.handleAgentEvent.engineeringLifecycle?.humanGate === 'spec_approval' &&
            this.root.handleAgentEvent.engineeringLifecycle.resumeToken
          ) {
            this.root.handleAgentEvent.engineeringLifecycle = (
              await invoke(
                'engineeringLifecycle:resume',
                this.root.handleAgentEvent.thread.projectId,
                this.root.handleAgentEvent.thread.id,
                this.root.handleAgentEvent.engineeringLifecycle.resumeToken,
                'continue'
              )
            ).state
          }
          if (active.status === 'draft') {
            active = await invoke(
              'spec:setReview',
              active.projectId,
              active.threadId,
              active.id,
              active.version
            )
          }
          if (active.status === 'in_review') {
            active = await invoke(
              'spec:approve',
              active.projectId,
              active.threadId,
              active.id,
              active.version
            )
          }
          await this.root.harnessUsage.setActiveSpec(active)
          this.root.handleAgentEvent.engineeringLifecycle = await invoke(
            'engineeringLifecycle:complete',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id,
            'spec'
          )
          if (this.root.handleAgentEvent.engineeringLifecycle.autopilot) {
            await this.generateAssignmentDraft()
            return
          }
          const nextEngineeringSettings = this.root.harnessUsage.settingsForEngineeringState(
            this.root.handleAgentEvent.engineeringLifecycle
          )
          this.root.contextUsage.updateSettings(nextEngineeringSettings)
          if (nextEngineeringSettings.assignmentMode) {
            if (this.assignment) this.openAssignmentStudio()
            else await this.generateAssignmentDraft()
            return
          }
          if (nextEngineeringSettings.assignmentMode || nextEngineeringSettings.loopMode) {
            return
          }
        }
        if (this.root.loadOlderMessages.settings.assignmentMode) {
          if (this.assignment) this.openAssignmentStudio()
          else await this.generateAssignmentDraft()
          return
        }
        if (active.status === 'draft') {
          active = await invoke(
            'spec:setReview',
            active.projectId,
            active.threadId,
            active.id,
            active.version
          )
        }
        if (active.status === 'in_review') {
          active = await invoke(
            'spec:approve',
            active.projectId,
            active.threadId,
            active.id,
            active.version
          )
        }
        await this.root.harnessUsage.setActiveSpec(active)
        if (active.content.assignment && this.root.loadOlderMessages.settings.assignmentMode) {
          await this.root.submitBrainstormDecision.reconcileReadySpec()
          return
        }
      }
      const contextAttachments = await invoke(
        'spec:getContextAttachments',
        active.projectId,
        active.threadId,
        active.id,
        active.version
      )
      await this.root.handleAgentEvent.sendMessage(
        this.root.buildSpecActionPrompt.buildSpecActionPrompt(action, active, notes),
        contextAttachments,
        action,
        undefined,
        undefined,
        [],
        [],
        workflowActionPresentation(specActionLabel(action), notes)
      )
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : `The specification ${action} action failed.`
    }
  }
}
