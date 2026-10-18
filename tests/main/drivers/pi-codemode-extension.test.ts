import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { piCodemodeExtension } from '../../../src/main/drivers/pi-codemode-extension'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface StubExtensionApi {
  on: (event: string, handler: () => void) => void
  getAllTools: () => Array<{ name: string }>
  getActiveTools: () => string[]
  setActiveTools: (names: string[]) => void
  /** What pi reports as the session's active tools. */
  activeTools: string[]
  emit: (event: string) => void
}

/**
 * Load the generated extension from a temp file exactly as pi does. The
 * fragment imports nothing but pi's own type, so the real module can be
 * imported here without pi's runtime.
 */
async function loadExtension(
  options: {
    /** Whether pi registered the script runner at all. */
    codemode?: boolean
    activeTools?: string[]
  } = {}
): Promise<StubExtensionApi> {
  const scratch = join(process.cwd(), '.cio', 'tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'pi-codemode-'))
  roots.push(root)
  const extensionPath = join(root, 'codemode.ts')
  await writeFile(extensionPath, piCodemodeExtension())
  const handlers = new Map<string, Array<() => void>>()
  const api = {
    activeTools: options.activeTools ?? [],
    getAllTools: () =>
      options.codemode === false
        ? [{ name: 'read' }, { name: 'bash' }]
        : [{ name: 'read' }, { name: 'bash' }, { name: 'codemode' }],
    getActiveTools: () => api.activeTools,
    setActiveTools: (names: string[]) => {
      api.activeTools = names
    },
    on: (event: string, handler: () => void) => {
      const existing = handlers.get(event) ?? []
      existing.push(handler)
      handlers.set(event, existing)
    },
    emit: (event: string) => {
      for (const handler of handlers.get(event) ?? []) handler()
    }
  }
  const module = (await import(pathToFileURL(extensionPath).href)) as {
    default: (pi: unknown) => void
  }
  module.default(api)
  return api
}

describe('piCodemodeExtension', () => {
  it('activates the script runner pi left inactive', async () => {
    const api = await loadExtension()

    api.emit('session_start')

    expect(api.activeTools).toContain('codemode')
  })

  it('leaves a runtime that never registered the script runner alone', async () => {
    const api = await loadExtension({ codemode: false })

    api.emit('session_start')

    expect(api.activeTools).toEqual([])
  })

  it('does not activate the script runner twice', async () => {
    const api = await loadExtension({ activeTools: ['read', 'codemode'] })

    api.emit('session_start')
    api.emit('before_agent_start')

    expect(api.activeTools).toEqual(['read', 'codemode'])
  })
})
