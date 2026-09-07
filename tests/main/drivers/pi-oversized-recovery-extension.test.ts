import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { piOversizedRecoveryExtension } from '../../../src/main/drivers/pi-oversized-recovery-extension'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface ContextMessage {
  role: string
  content: unknown
}

/** Load the generated extension with a stub ExtensionAPI and flag file. */
async function loadExtension(armed: boolean): Promise<{
  context: (event: { messages: ContextMessage[] }) => Promise<{ messages: ContextMessage[] } | undefined>
}> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-pi-oversized-'))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'flag.json'), JSON.stringify({ armed }))
  const source = piOversizedRecoveryExtension().replace(
    '__CIO_OVERSIZED_FLAG_PATH__',
    join(root, 'flag.json')
  )
  await writeFile(join(root, 'ext.ts'), source)
  const handlers: Record<string, Array<(event: never) => Promise<unknown>>> = {}
  const module = await import(pathToFileURL(join(root, 'ext.ts')).href)
  module.default({
    on: (name: string, fn: (event: never) => Promise<unknown>) => {
      ;(handlers[name] ??= []).push(fn)
    }
  })
  const context = handlers['context']?.[0]
  if (!context) throw new Error('Generated extension registered no context hook')
  return { context: context as (event: { messages: ContextMessage[] }) => Promise<{ messages: ContextMessage[] } | undefined> }
}

describe('piOversizedRecoveryExtension', () => {
  const messages: ContextMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'tool',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', data: 'QUFBQQ==', mimeType: 'image/png' }
      ]
    }
  ]

  it('replaces image parts with placeholders in the request copy while armed', async () => {
    const { context } = await loadExtension(true)
    const result = await context({ messages: structuredClone(messages) })
    expect(result).toBeDefined()
    const tool = result?.messages[1]?.content as Array<{ type: string; text?: string }>
    expect(tool.some((part) => part.type === 'image')).toBe(false)
    expect(tool[1]?.text).toContain('image removed from the provider request')
    // The caller's messages are untouched (non-destructive).
    const original = messages[1]?.content as Array<{ type: string }>
    expect(original.some((part) => part.type === 'image')).toBe(true)
  })

  it('leaves messages untouched while disarmed', async () => {
    const { context } = await loadExtension(false)
    const result = await context({ messages: structuredClone(messages) })
    expect(result).toBeUndefined()
  })

  it('truncates oversized text parts while armed', async () => {
    const { context } = await loadExtension(true)
    const huge = 'x'.repeat(500_000)
    const result = await context({
      messages: [{ role: 'user', content: [{ type: 'text', text: huge }] }]
    })
    const text = (result?.messages[0]?.content as Array<{ type: string; text?: string }>)[0]
      ?.text
    expect(text?.length ?? 0).toBeLessThan(huge.length)
    expect(text).toContain('truncated from the provider request')
  })
})
