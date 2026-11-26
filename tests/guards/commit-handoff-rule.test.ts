/******************************************************************************
 *                                                                           *
 *   STOP.  THIS GUARD IS NOT NEGOTIABLE AND NOT EDITABLE TO GET GREEN.      *
 *                                                                           *
 *   It enforces one promise: an agent's work is only finished when it is    *
 *   committed with a hash read back from git log, and every agent that is   *
 *   forbidden to commit has to hand its changed paths up as uncommitted.    *
 *                                                                           *
 *   Both halves were the same failure in practice: a worker's brief said    *
 *   "do not commit", the spawning agent read the report and ended the turn  *
 *   without committing or mentioning it, and the user found a dirty tree    *
 *   with nothing to audit. A prompt that only forbids committing, without   *
 *   naming who inherits the commit, produces exactly that.                 *
 *                                                                           *
 *   DO NOT: remove the verification step, the "never claim a commit" rule,  *
 *   the handoff obligation, or the uncommitted path list from a contract.   *
 *   Add the missing agent role instead.                                    *
 *                                                                           *
 ******************************************************************************/
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AGENT_BEHAVIOR_PROMPT,
  PAWN_AGENT_CONTRACT,
  WORKER_AGENT_BEHAVIOR_PROMPT
} from '../../src/lib/agent-behavior'

const projectRoot = join(import.meta.dirname, '..', '..')

// Cheap tripwire for "someone emptied the file instead of deleting it".
const GUARD_CANARY = 'COMMIT-HANDOFF-GUARD-CANARY'

async function readSource(relativePath: string): Promise<string> {
  return await readFile(join(projectRoot, relativePath), 'utf8')
}

describe('commit handoff rule', () => {
  it('makes the primary agent verify and report the hash it committed', () => {
    const prompt = DEFAULT_AGENT_BEHAVIOR_PROMPT
    expect(prompt).toContain('git log -1 --stat')
    expect(prompt).toContain('Never claim a commit you did not make or did not verify')
    expect(prompt).toContain('unfinished task, not a delivered one')
  })

  it('gives the commit an owner when a brief forbids committing', () => {
    const prompt = DEFAULT_AGENT_BEHAVIOR_PROMPT
    expect(prompt).toContain('You own the handoff')
    expect(prompt).toContain('not complete while reported changes are uncommitted')
    expect(prompt).toContain('If no agent in the chain is allowed to commit')
  })

  it('does not let a verified change end the run uncommitted', () => {
    // The failure this locks: a turn that finished on "fix verified, three
    // states render correctly" and ended there, with no commit step and no
    // sentence about the paths git status still listed. "Verified" is a check
    // result, and the prompt has to say so where the agent reads its own
    // definition of done, not only in a rule about claiming a hash.
    const prompt = DEFAULT_AGENT_BEHAVIOR_PROMPT
    expect(prompt).toContain('the commit is still ahead of you and the turn is not over')
    expect(prompt).toContain('approval to land it')
    expect(prompt).toContain('ask whether to commit it')
    expect(prompt).toContain('or named path by path as deliberately left uncommitted')
  })

  it('makes a worker hand its changed paths up as uncommitted', () => {
    const prompt = WORKER_AGENT_BEHAVIOR_PROMPT
    expect(prompt).toContain('Your report is the handoff')
    expect(prompt).toContain('as uncommitted')
    expect(prompt).toContain('Never call your own work committed')
  })

  it('makes a pawn hand its changed paths up as uncommitted', () => {
    const contract = PAWN_AGENT_CONTRACT
    expect(contract).toContain('as uncommitted')
    expect(contract).toContain('Never call your own work committed')
  })

  it('tells the spawning agent that the commit dies with it', async () => {
    // The pawn lives in its own unit since the delegation split, so the handoff
    // is read where the spawner's report is actually written.
    const assignmentWorkers = await readSource(
      'src/main/chat/chat-engine/chat-engine-assignment-workers/chat-engine-assignment-workers-pawns.ts'
    )
    expect(assignmentWorkers).toContain('the commit is yours or nobody makes it')
    const subagents = await readSource('src/main/drivers/pi/tools/core-tools-subagents.ts')
    expect(subagents).toContain('marked uncommitted')
    expect(subagents).toContain('read back from git log')
  })

  it('keeps this guard itself intact', async () => {
    const source = await readFile(join(import.meta.dirname, 'commit-handoff-rule.test.ts'), 'utf8')
    expect(source).toContain(GUARD_CANARY)
    // Built from parts so this assertion cannot match its own source text.
    const focused = ['.', 'only', '('].join('')
    const skipped = ['.', 'skip', '('].join('')
    expect(source).not.toContain(focused)
    expect(source).not.toContain(skipped)
  })
})
