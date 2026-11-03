import { describe, expect, it } from 'vitest'
import { assistantRowScopeLabel } from '../../src/renderer/lib/components/threads/bound-scope-label'

/**
 * An assistant sidebar row states its scope and nothing it already said.
 *
 * The row already carries the assistant, the task title and its schedule, so the
 * only new fact a bound task adds is the short scope it works in. The project is
 * never repeated, and an unbound task adds no line at all rather than an empty
 * placeholder on every ordinary task.
 */

describe('assistant sidebar row scope', () => {
  it('abbreviates a long scope name the way the rest of the app does', () => {
    expect(
      assistantRowScopeLabel({
        boundScope: { projectId: 'project1', scopeBucketId: 'scope-1' },
        bucketName: 'Achievement: Admin Dashboard Requirements for User Roles, Content'
      })
    ).toBe('Achievement: Admin…')
  })

  it('leaves a short scope name whole', () => {
    expect(
      assistantRowScopeLabel({
        boundScope: { projectId: 'project1', scopeBucketId: 'scope-1' },
        bucketName: 'Bound assistant tasks'
      })
    ).toBe('Bound assistant tasks')
  })

  it('never renders a project name', () => {
    const label = assistantRowScopeLabel({
      boundScope: { projectId: 'project1', scopeBucketId: 'scope-1' },
      bucketName: 'Default'
    })
    expect(label).toBe('Default')
    expect(label).not.toContain('project1')
  })

  it('omits the line entirely for an unbound task', () => {
    expect(assistantRowScopeLabel({})).toBeNull()
    expect(assistantRowScopeLabel({ boundScope: undefined, bucketName: 'Default' })).toBeNull()
  })

  it('names the scope id when the board carries no name yet', () => {
    expect(
      assistantRowScopeLabel({
        boundScope: { projectId: 'project1', scopeBucketId: 'scope-mw0ou46n' },
        bucketName: '   '
      })
    ).toBe('scope-mw0ou46n')
  })
})
