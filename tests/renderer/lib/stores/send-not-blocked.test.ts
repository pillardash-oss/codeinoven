import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A send does not wait for the backend.
 *
 * The words leave the box and land in the transcript in the click's own task; the
 * turn, its persistence and every gate behind it follow. The one thing that put a
 * round trip in front of the message was the expert gate: its answer was read over
 * IPC after the words were handed over, on every single send, so a busy main
 * process meant the message the user already sent was not on screen. It is read
 * once when the composer mounts now, and the send path answers from that.
 *
 * Read from source: the composer board reaches IPC at import time.
 */

function source(...parts: string[]): string {
  return readFileSync(
    join(process.cwd(), 'src', 'renderer', 'lib', 'components', 'chats', ...parts),
    'utf8'
  ).replace(/\r\n/gu, '\n')
}

describe('sending a message', () => {
  it('answers the expert gate from the warm copy instead of an IPC read', () => {
    const submit = source('ChatComposer', 'ChatComposer-submit.svelte.ts')
    expect(submit).toMatch(/const warm = this\.root\.captureComposerRoot\.cachedExpertState\(\)/u)
    expect(submit).toMatch(/this\.decideWithExpertState\(warm, msg, direct\)/u)
    // The decision itself is synchronous: it is what a warm send runs.
    expect(submit).toMatch(
      /decideWithExpertState\(state: ThreadExpertState \| null, msg: string, direct\?: boolean\): void \{/u
    )
    // And the send is dispatched from it without awaiting anything.
    expect(submit).toMatch(/\n\s+this\.performSend\(direct\)\n\s+return\n/u)
  })

  it('reads the gate once, when the composer mounts', () => {
    const root = source('ChatComposer', 'ChatComposer-capture-composer-root.svelte.ts')
    expect(root).toMatch(/prefetchExpertState\(\): void \{/u)
    expect(root).toMatch(/cachedExpertState\(\): ThreadExpertState \| null \| undefined \{/u)
    const effects = source('ChatComposer', 'ChatComposer-effects.svelte.ts')
    expect(effects).toMatch(/prefetchExpertState\(\)/u)
  })

  it('keeps the warm copy honest when the user answers the card', () => {
    const root = source('ChatComposer', 'ChatComposer-capture-composer-root.svelte.ts')
    const decide = root.slice(root.indexOf('async decideExperts('))
    expect(decide).toMatch(/this\.expertState = decided/u)
  })
})
