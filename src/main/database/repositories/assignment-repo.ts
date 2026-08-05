import type { Database } from '../database'
import type { AssignmentPlan, AssignmentStatus, AssignmentToolResult } from '../../../lib/types'

interface AssignmentWorkflowRow {
  assignment_id: string
  active_version: number
  approved_version: number | null
  status: AssignmentStatus
}

export class AssignmentRepo {
  constructor(private readonly db: Database) {}

  getVersion(assignmentId: string, version: number): AssignmentPlan | null {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM assignment_versions WHERE assignment_id=? AND version=?',
      assignmentId,
      version
    )
    return row ? (JSON.parse(row.data) as AssignmentPlan) : null
  }

  getActive(projectId: string, coordinatorThreadId: string): AssignmentPlan | null {
    const workflow = this.db.get<AssignmentWorkflowRow>(
      'SELECT assignment_id, active_version, approved_version, status FROM assignment_workflow WHERE project_id=? AND coordinator_thread_id=?',
      projectId,
      coordinatorThreadId
    )
    return workflow ? this.getVersion(workflow.assignment_id, workflow.active_version) : null
  }

  listVersions(assignmentId: string): AssignmentPlan[] {
    return this.db
      .all<{ data: string }>(
        'SELECT data FROM assignment_versions WHERE assignment_id=? ORDER BY version',
        assignmentId
      )
      .map((row) => JSON.parse(row.data) as AssignmentPlan)
  }

  save(plan: AssignmentPlan, approvedVersion?: number): void {
    const existingWorkflow = this.db.get<{ approved_version: number | null }>(
      'SELECT approved_version FROM assignment_workflow WHERE project_id=? AND coordinator_thread_id=?',
      plan.projectId,
      plan.coordinatorThreadId
    )
    this.db.run(
      `INSERT INTO assignment_versions(
        assignment_id, version, project_id, coordinator_thread_id,
        spec_id, spec_version, status, data, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(assignment_id, version) DO UPDATE SET
        status=excluded.status,
        data=excluded.data,
        updated_at=excluded.updated_at`,
      plan.id,
      plan.version,
      plan.projectId,
      plan.coordinatorThreadId,
      plan.specId,
      plan.specVersion,
      plan.status,
      JSON.stringify(plan),
      plan.createdAt,
      plan.updatedAt
    )
    this.db.run(
      `INSERT INTO assignment_workflow(
        project_id, coordinator_thread_id, assignment_id, active_version,
        approved_version, status, updated_at
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(project_id, coordinator_thread_id) DO UPDATE SET
        assignment_id=excluded.assignment_id,
        active_version=excluded.active_version,
        approved_version=excluded.approved_version,
        status=excluded.status,
        updated_at=excluded.updated_at`,
      plan.projectId,
      plan.coordinatorThreadId,
      plan.id,
      plan.version,
      approvedVersion ?? existingWorkflow?.approved_version ?? null,
      plan.status,
      plan.updatedAt
    )
  }

  getOperation(
    operationId: string,
    assignmentId: string,
    toolName: string
  ): AssignmentToolResult | null {
    const row = this.db.get<{ result: string }>(
      'SELECT result FROM assignment_operations WHERE operation_id=? AND assignment_id=? AND tool_name=?',
      operationId,
      assignmentId,
      toolName
    )
    if (!row || row.result === 'null') return null
    return JSON.parse(row.result) as AssignmentToolResult
  }

  claimOperation(operationId: string, assignmentId: string, toolName: string): boolean {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO assignment_operations(operation_id, assignment_id, tool_name, result, created_at) VALUES(?,?,?,?,?)'
      )
      .run(operationId, assignmentId, toolName, 'null', Date.now())
    return result.changes === 1
  }

  completeOperation(
    operationId: string,
    assignmentId: string,
    toolName: string,
    result: AssignmentToolResult
  ): void {
    this.db.run(
      'UPDATE assignment_operations SET result=? WHERE operation_id=? AND assignment_id=? AND tool_name=?',
      JSON.stringify(result),
      operationId,
      assignmentId,
      toolName
    )
  }

  releaseOperation(operationId: string, assignmentId: string, toolName: string): void {
    this.db.run(
      'DELETE FROM assignment_operations WHERE operation_id=? AND assignment_id=? AND tool_name=? AND result=?',
      operationId,
      assignmentId,
      toolName,
      'null'
    )
  }

  claimCoordinatorSnapshot(
    assignmentId: string,
    snapshotHash: string,
    snapshotJson: string
  ): boolean {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO assignment_coordinator_snapshots(assignment_id, snapshot_hash, snapshot_json, claimed_at) VALUES(?,?,?,?)'
      )
      .run(assignmentId, snapshotHash, snapshotJson, Date.now())
    return result.changes === 1
  }

  releaseCoordinatorSnapshot(assignmentId: string, snapshotHash: string): void {
    this.db.run(
      'DELETE FROM assignment_coordinator_snapshots WHERE assignment_id=? AND snapshot_hash=?',
      assignmentId,
      snapshotHash
    )
  }
}
