import { describe, expect, it } from 'vitest'
import type { GitFileChange } from '../../../src/lib/types'
import {
  applyStageIntents,
  type StageIntents
} from '../../../src/renderer/lib/git-optimistic-staging'

function change(
  path: string,
  staged: boolean,
  status: GitFileChange['status'] = 'modified'
): GitFileChange {
  return { path, staged, status }
}

const intent = (staged: boolean, request = 1): StageIntents => ({
  'src/a.ts': { staged, request }
})

describe('applyStageIntents', () => {
  it('leaves everything alone when nothing was asked', () => {
    const changes = [change('src/a.ts', false)]
    expect(applyStageIntents(changes, {})).toEqual(changes)
  })

  it('paints a staged file before git has answered', () => {
    const painted = applyStageIntents([change('src/a.ts', false)], intent(true))
    expect(painted).toEqual([change('src/a.ts', true)])
  })

  it('paints an unstage as well', () => {
    const painted = applyStageIntents([change('src/a.ts', true)], intent(false))
    expect(painted).toEqual([change('src/a.ts', false)])
  })

  it('collapses a half-staged file into the index instead of showing it twice', () => {
    // Git lists an `MM` file once per side; staging it is what makes it one row.
    const painted = applyStageIntents(
      [change('src/a.ts', true), change('src/a.ts', false), change('src/b.ts', false)],
      intent(true)
    )
    expect(painted).toEqual([change('src/a.ts', true), change('src/b.ts', false)])
  })

  it('splits a staged file back into the working tree', () => {
    const painted = applyStageIntents([change('src/a.ts', true)], intent(false))
    expect(painted.map((file) => file.staged)).toEqual([false])
  })

  it('moves an untracked file to added when it is staged', () => {
    const painted = applyStageIntents([change('src/a.ts', false, 'untracked')], intent(true))
    expect(painted[0]?.status).toBe('added')
    expect(painted[0]?.staged).toBe(true)
  })

  it('moves a new file back to untracked when it is unstaged', () => {
    const painted = applyStageIntents([change('src/a.ts', true, 'added')], intent(false))
    expect(painted[0]?.status).toBe('untracked')
    expect(painted[0]?.staged).toBe(false)
  })

  it('keeps the order git reported', () => {
    const changes = [
      change('src/b.ts', false),
      change('src/a.ts', false),
      change('src/c.ts', false)
    ]
    const painted = applyStageIntents(changes, intent(true))
    expect(painted.map((file) => file.path)).toEqual(['src/b.ts', 'src/a.ts', 'src/c.ts'])
  })
})
