import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { MemoryService } from './memory-service'
import { PromptAssembler, clearInstructionCache, instructionCacheSize } from './prompt-assembler'

const temporaryRoots: string[] = []

afterEach(async () => {
  clearInstructionCache()
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function assembler(): PromptAssembler {
  const memoryService = { formatCurrent: async () => '' } as unknown as MemoryService
  return new PromptAssembler(memoryService)
}

describe('PromptAssembler instruction cache', () => {
  it('serves AGENTS.md from the path+mtime+size cache and invalidates on change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-instruction-'))
    temporaryRoots.push(root)
    const agentsPath = join(root, 'AGENTS.md')
    await writeFile(agentsPath, 'Rule one', 'utf-8')

    const service = assembler()
    const first = await service.getLayers('project-1', 'thread-1', root, null)
    expect(first.find((layer) => layer.title === 'AGENTS.md (Project)')?.content).toContain(
      'Rule one'
    )
    expect(instructionCacheSize()).toBeGreaterThan(0)

    // An unchanged file is served from cache without re-reading.
    const second = await service.getLayers('project-1', 'thread-1', root, null)
    expect(second.find((layer) => layer.title === 'AGENTS.md (Project)')?.content).toContain(
      'Rule one'
    )

    // Changing the file (mtime/size) invalidates the cached entry.
    await writeFile(agentsPath, 'Rule one\nRule two', 'utf-8')
    const third = await service.getLayers('project-1', 'thread-1', root, null)
    expect(third.find((layer) => layer.title === 'AGENTS.md (Project)')?.content).toContain(
      'Rule two'
    )
  })

  it('caches nested AGENTS.md files too', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codeinoven-instruction-nested-'))
    temporaryRoots.push(root)
    await writeFile(join(root, 'AGENTS.md'), 'Root rules', 'utf-8')
    await mkdir(join(root, 'packages'))
    await writeFile(join(root, 'packages', 'AGENTS.md'), 'Package rules', 'utf-8')

    const service = assembler()
    const layers = await service.getLayers('project-1', 'thread-1', root, null)
    expect(layers.some((layer) => layer.content === 'Package rules')).toBe(true)
    expect(instructionCacheSize()).toBeGreaterThan(1)
  })
})
