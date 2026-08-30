import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  finalizePrototypeArtifact,
  planPrototypeGeneration,
  resolvePrototypeArtifactPaths
} from '../../src/lib/prototypes/prototype-artifacts'
import {
  PrototypePreviewService,
  readPrototypePreviewChunk
} from '../../src/main/prototypes/prototype-preview-service'

const roots: string[] = []
const services: PrototypePreviewService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('prototype artifacts and preview service', () => {
  it('uses bounded default batches and stable identifiers', () => {
    expect(planPrototypeGeneration('lofi')).toEqual([
      [
        { id: 'L1', fidelity: 'lofi' },
        { id: 'L2', fidelity: 'lofi' }
      ]
    ])
    expect(planPrototypeGeneration('hifi')).toEqual([[{ id: 'H1', fidelity: 'hifi' }]])
    expect(planPrototypeGeneration('lofi', 3)).toHaveLength(2)
  })

  it('finalizes a scoped artifact and streams it with isolated security headers', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'codeinoven-prototype-'))
    roots.push(projectRoot)
    const paths = resolvePrototypeArtifactPaths(projectRoot, 'toolbox', 'L1')
    await mkdir(paths.canonicalRoot, { recursive: true })
    await writeFile(join(paths.canonicalRoot, 'index.html'), '<h1>LoFi</h1>')
    const prototype = await finalizePrototypeArtifact({
      projectRoot,
      featureSlug: 'toolbox',
      prototypeId: 'L1',
      fidelity: 'lofi',
      title: 'Compact toolbox',
      entryFile: 'index.html',
      createdAt: 10
    })
    expect(prototype.previewPath).toBe('cio/toolbox-l1/')

    const service = new PrototypePreviewService()
    services.push(service)
    await expect(service.registerProject(projectRoot)).resolves.toBe(1)
    const chunk = await readPrototypePreviewChunk(paths.canonicalRoot, 'index.html', 0)
    expect(Buffer.from(chunk.base64, 'base64').toString('utf8')).toContain('LoFi')
    const port = await service.start()
    const response = await fetch(`http://127.0.0.1:${port}/${prototype.previewPath}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
    await expect(response.text()).resolves.toContain('LoFi')
    await expect(fetch(`http://127.0.0.1:${port}/cio/toolbox-l1/../secret`)).resolves.toMatchObject(
      {
        status: 404
      }
    )
  })

  it('rejects traversal and refuses to overwrite a preview path', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'codeinoven-prototype-'))
    roots.push(projectRoot)
    expect(() => resolvePrototypeArtifactPaths(projectRoot, '../escape', 'L1')).toThrow()
    const paths = resolvePrototypeArtifactPaths(projectRoot, 'toolbox', 'L1')
    await mkdir(paths.canonicalRoot, { recursive: true })
    await mkdir(paths.previewRoot, { recursive: true })
    await writeFile(join(paths.canonicalRoot, 'index.html'), 'safe')
    await expect(
      finalizePrototypeArtifact({
        projectRoot,
        featureSlug: 'toolbox',
        prototypeId: 'L1',
        fidelity: 'lofi',
        title: 'Safe',
        entryFile: 'index.html'
      })
    ).rejects.toThrow('already exists')
  })

  it('allows regenerating the same prototype id by replacing its own preview link', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'codeinoven-prototype-'))
    roots.push(projectRoot)
    const paths = resolvePrototypeArtifactPaths(projectRoot, 'toolbox', 'H1')
    await mkdir(paths.canonicalRoot, { recursive: true })
    await writeFile(join(paths.canonicalRoot, 'index.html'), '<h1>v1</h1>')
    await finalizePrototypeArtifact({
      projectRoot,
      featureSlug: 'toolbox',
      prototypeId: 'H1',
      fidelity: 'hifi',
      title: 'Rebuild me',
      entryFile: 'index.html'
    })

    await writeFile(join(paths.canonicalRoot, 'index.html'), '<h1>v2</h1>')
    const rebuilt = await finalizePrototypeArtifact({
      projectRoot,
      featureSlug: 'toolbox',
      prototypeId: 'H1',
      fidelity: 'hifi',
      title: 'Rebuild me',
      entryFile: 'index.html'
    })
    expect(rebuilt.previewPath).toBe('cio/toolbox-h1/')
    const chunk = await readPrototypePreviewChunk(paths.canonicalRoot, 'index.html', 0)
    expect(Buffer.from(chunk.base64, 'base64').toString('utf8')).toContain('v2')
  })
})
