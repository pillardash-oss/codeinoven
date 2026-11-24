/******************************************************************************
 *                                                                           *
 *   STOP.  THIS GUARD IS NOT NEGOTIABLE AND NOT EDITABLE TO GET GREEN.      *
 *                                                                           *
 *   It enforces one promise: the app's own behaviour prompt, which every    *
 *   harness and every project receives, tells the agent that disposable     *
 *   work goes to `.cio/tmp/` and never to the OS temp directory.  The rule  *
 *   lived for a while only as one soft sentence, and models kept writing    *
 *   scratch to /tmp, $TMPDIR and mktemp in user projects.                   *
 *                                                                           *
 *   The vehicle is the app prompt, never a project file: CodeInOven is      *
 *   installed across many projects, so the rule has to travel with the app  *
 *   and never depend on a repository carrying its own AGENTS.md.            *
 *                                                                           *
 *   DO NOT: delete a banned form from a prompt to shorten it, move the rule *
 *   into a project instruction file, or weaken an assertion.  The fix for   *
 *   "a model used the OS temp path" is another banned form named in the     *
 *   prompt, not a looser guard.                                             *
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
const GUARD_CANARY = 'SCRATCH-PATH-GUARD-CANARY'

/** Forms of the OS temp directory the prompt must name to be unmissable. */
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

/** Every source that delivers the behaviour prompt to a running agent. */
const PROMPT_DELIVERY_SITES = [
  'src/lib/cio-prompts.ts',
  'src/renderer/app-defaults.ts',
  'src/main/chat/prompt-assembler.ts',
  'src/main/chat/chat-engine/chat-engine-prompts.ts',
  'src/main/chat/chat-engine/chat-engine-turns-dispatch.ts'
] as const

async function readSource(relativePath: string): Promise<string> {
  return await readFile(join(projectRoot, relativePath), 'utf8')
}

describe('scratch path rule', () => {
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
    for (const form of BANNED_FORMS) {
      expect(prompt).toContain(form)
    }
    expect(prompt).toContain('banned')
  })

  it('carries the same ban into the pawn contract, which embeds the worker rules', () => {
    const prompt = PAWN_AGENT_CONTRACT
    expect(prompt).toContain(SCRATCH_PATH)
    for (const form of BANNED_FORMS) {
      expect(prompt).toContain(form)
    }
  })

  it('reaches every harness through the shared default, never a project file', async () => {
    for (const site of PROMPT_DELIVERY_SITES) {
      const source = await readSource(site)
      expect(source, `${site} must deliver the shared default prompt`).toContain(
        'DEFAULT_AGENT_BEHAVIOR_PROMPT'
      )
    }
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
