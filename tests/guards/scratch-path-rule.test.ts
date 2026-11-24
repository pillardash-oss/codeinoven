/******************************************************************************
 *                                                                           *
 *   STOP.  THIS GUARD IS NOT NEGOTIABLE AND NOT EDITABLE TO GET GREEN.      *
 *                                                                           *
 *   It enforces one promise: every model is told, in every instruction      *
 *   surface that reaches it, that disposable work goes to `.cio/tmp/` and   *
 *   never to the OS temp directory.  The rule was carried by the app prompt *
 *   alone for a long time, so a model working inside this repository        *
 *   (which reads AGENTS.md and nothing else) obeyed nothing, and wrote      *
 *   scratch to /tmp, $TMPDIR and mktemp again and again.                    *
 *                                                                           *
 *   DO NOT: delete a phrase from AGENTS.md or from a prompt to shorten it,  *
 *   move the rule somewhere an agent stops reading, or weaken an assertion. *
 *   The correct fix for "a model used the OS temp path" is another banned   *
 *   form named in the rule, not a looser guard.                             *
 *                                                                           *
 ******************************************************************************/
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AGENT_BEHAVIOR_PROMPT,
  WORKER_AGENT_BEHAVIOR_PROMPT
} from '../../src/lib/agent-behavior'

const projectRoot = join(import.meta.dirname, '..', '..')

// Cheap tripwire for "someone emptied the file instead of deleting it".
const GUARD_CANARY = 'SCRATCH-PATH-GUARD-CANARY'

/** Forms of the OS temp directory the rule must name to be unmissable. */
const BANNED_FORMS = [
  'os.tmpdir()',
  '$TMPDIR',
  '%TEMP%',
  'mktemp',
  'tempfile',
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/var/folders'
] as const

/** The workspace scratch path every surface must point at instead. */
const SCRATCH_PATH = '.cio/tmp/'

async function readAgentsMd(): Promise<string> {
  return await readFile(join(projectRoot, 'AGENTS.md'), 'utf8')
}

describe('scratch path rule', () => {
  it('names the rule as a hard section in the project instructions', async () => {
    const agents = await readAgentsMd()
    expect(agents).toContain('## Scratch And Temp Paths (hard rule, no exceptions)')
    expect(agents).toContain(SCRATCH_PATH)
    for (const form of BANNED_FORMS) {
      expect(agents).toContain(form)
    }
  })

  it('repeats the rule in the project rules list an agent skims last', async () => {
    const agents = await readAgentsMd()
    const bullet = agents
      .split('\n')
      .find((line) => line.includes('`os.tmpdir()`') && line.includes('Scratch And Temp Paths'))
    expect(bullet).toBeDefined()
    expect(bullet).toContain(SCRATCH_PATH)
  })

  it('bans the OS temp directory in the primary agent behaviour prompt', () => {
    const prompt = DEFAULT_AGENT_BEHAVIOR_PROMPT
    expect(prompt).toContain(SCRATCH_PATH)
    for (const form of BANNED_FORMS) {
      expect(prompt).toContain(form)
    }
    expect(prompt).toContain('banned')
  })

  it('carries the same ban into the worker contract a sub-agent inherits', () => {
    const prompt = WORKER_AGENT_BEHAVIOR_PROMPT
    expect(prompt).toContain(SCRATCH_PATH)
    expect(prompt).toContain('os.tmpdir()')
    expect(prompt).toContain('mktemp')
    expect(prompt).toContain('banned')
  })

  it('keeps this guard itself intact', async () => {
    const source = await readFile(join(import.meta.dirname, 'scratch-path-rule.test.ts'), 'utf8')
    expect(source).toContain(GUARD_CANARY)
    // Built from parts so this assertion cannot match its own source text.
    const focused = ['.', 'only', '('].join('')
    const skipped = ['.', 'skip', '('].join('')
    expect(source).not.toContain(focused)
    expect(source).not.toContain(skipped)
  })
})
