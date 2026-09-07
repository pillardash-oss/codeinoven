import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { piCompactionExtension } from '../../../src/main/drivers/pi-compaction-extension'

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
  context: (event: {
    messages: ContextMessage[]
  }) => Promise<{ messages: ContextMessage[] } | undefined>
}> {
  const scratch = join(process.cwd(), '.cio', 'tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'pi-compaction-recovery-'))
  roots.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'flag.json'), JSON.stringify({ armed }))
  // Pi injects its extension API module. Load only the two real helpers here:
  // importing the package root outside Pi also loads its optional server SDK.
  const sdk = join(process.cwd(), 'node_modules/@earendil-works/pi-coding-agent/dist/core')
  const source = piCompactionExtension()
    .replace('__CIO_OVERSIZED_FLAG_PATH__', join(root, 'flag.json'))
    .replace(
      "import { convertToLlm, serializeConversation } from '@earendil-works/pi-coding-agent'",
      `import { convertToLlm } from '${pathToFileURL(join(sdk, 'messages.js')).href}'\nimport { serializeConversation } from '${pathToFileURL(join(sdk, 'compaction/utils.js')).href}'`
    )
  await writeFile(join(root, 'ext.ts'), source)
  type ContextHook = (
    event: { messages: ContextMessage[] },
    ctx: { getContextUsage(): undefined }
  ) => Promise<{ messages: ContextMessage[] } | undefined>
  const handlers: Record<string, ContextHook[]> = {}
  const module = await import(pathToFileURL(join(root, 'ext.ts')).href)
  module.default({
    on: (name: string, fn: ContextHook) => {
      ;(handlers[name] ??= []).push(fn)
    }
  })
  const context = handlers['context']?.[0]
  if (!context) throw new Error('Generated extension registered no context hook')
  return { context: (event) => context(event, { getContextUsage: () => undefined }) }
}

describe('piCompactionExtension', () => {
  const messages: ContextMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'toolResult',
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
    const text = (result?.messages[0]?.content as Array<{ type: string; text?: string }>)[0]?.text
    expect(text?.length ?? 0).toBeLessThan(huge.length)
    expect(text).toContain('truncated from the provider request')
  })
})
