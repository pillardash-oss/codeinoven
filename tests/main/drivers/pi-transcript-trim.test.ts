/**
 * Native Pi history trimming.
 *
 * The trimmer appends Pi's own `context_edit` records instead of rewriting the
 * transcript, so this test checks both halves of that promise: the file keeps
 * every original entry, and Pi's own context projection stops showing the
 * trimmed ones. Nothing here starts a Pi process.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { afterAll, describe, expect, it } from 'vitest'
import { trimPiTranscript } from '../../../src/main/drivers/pi/pi-transcript-trim'
import type { AgentMessage } from '../../../src/lib/types'

const scratch = join(process.cwd(), '.cio', 'tmp', 'pi-transcript-trim-test')

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** A mirrored app message with one text part, the shape the engine hands over. */
function mirrored(id: string, role: AgentMessage['role'], text: string): AgentMessage {
  return {
    id,
    role,
    createdAt: 0,
    parts: [{ type: 'text', id: `${id}:text:0`, text }]
  } as unknown as AgentMessage
}

/** Write a transcript pi itself would have written, then read it back. */
function transcript(
  cwd: string,
  turns: Array<{ role: 'user' | 'assistant'; text: string }>
): string {
  rmSync(cwd, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  const path = join(cwd, '2026-01-01T00-00-00-000Z_01test00000000000000000000a.jsonl')
  writeFileSync(path, '')
  const manager = SessionManager.create(cwd, join(cwd, 'sessions'))
  for (const turn of turns) {
    manager.appendMessage({
      role: turn.role,
      content: [{ type: 'text', text: turn.text }],
      timestamp: 0
    } as unknown as Parameters<SessionManager['appendMessage']>[0])
  }
  // Hand the file pi wrote to the trimmer, named the way pi names it.
  const written = manager.getSessionFile()
  if (!written) throw new Error('pi wrote no session file')
  writeFileSync(path, readFileSync(written))
  return path
}

describe('trimPiTranscript', () => {
  it('appends context edits and keeps every original entry', async () => {
    const path = transcript(join(scratch, 'basic'), [
      { role: 'user', text: 'first question' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'second question' },
      { role: 'assistant', text: 'second answer' }
    ])
    const before = readFileSync(path, 'utf8').split('\n').filter(Boolean)

    const result = await trimPiTranscript(path, [mirrored('m-3', 'user', 'second question')])

    expect(result).toEqual({ edited: 1, missing: 0 })
    const after = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    // Appended, never rewritten.
    expect(after.slice(0, before.length)).toEqual(before)
    const appended = JSON.parse(after[after.length - 1] ?? '{}') as Record<string, unknown>
    expect(appended['type']).toBe('context_edit')
    expect(appended['replacement']).toBeNull()
    expect(typeof appended['targetId']).toBe('string')

    // Pi's own projection is the authority on whether the trim took effect.
    const projection = SessionManager.open(path).buildSessionProjection()
    const visible = JSON.stringify(projection.messages)
    expect(visible).not.toContain('second question')
    expect(visible).toContain('second answer')
    expect(visible).toContain('first answer')
  })

  it('takes an assistant message and its tool results out together', async () => {
    const cwd = join(scratch, 'tools')
    const path = transcript(cwd, [
      { role: 'user', text: 'read the file' },
      { role: 'assistant', text: 'reading it now' }
    ])
    // Give the assistant message a tool result child, the way a real turn does:
    // pi records the result as a child of the message that asked for the tool.
    const entries = readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const assistant = entries.filter((entry) => entry['type'] === 'message').at(-1)
    if (!assistant) throw new Error('no assistant entry')
    writeFileSync(
      path,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n${JSON.stringify({
        type: 'message',
        id: 'toolresult1',
        parentId: assistant['id'],
        timestamp: new Date().toISOString(),
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          content: [{ type: 'text', text: 'tool output the model should not see again' }],
          timestamp: 0
        }
      })}\n`
    )

    const result = await trimPiTranscript(path, [mirrored('m-2', 'assistant', 'reading it now')])

    expect(result.missing).toBe(0)
    const visible = JSON.stringify(SessionManager.open(path).buildSessionProjection().messages)
    expect(visible).not.toContain('reading it now')
    expect(visible).not.toContain('tool output the model should not see again')
    expect(visible).toContain('read the file')
  })

  it('refuses when a removed user turn is not in the transcript', async () => {
    const path = transcript(join(scratch, 'missing'), [{ role: 'user', text: 'only question' }])
    const before = readFileSync(path, 'utf8')

    const result = await trimPiTranscript(path, [
      mirrored('m-9', 'user', 'a question it never had')
    ])

    expect(result).toEqual({ edited: 0, missing: 1 })
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})
