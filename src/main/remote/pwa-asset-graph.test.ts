import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computePwaAssetClosure, computePwaAssetGraph } from './pwa-asset-graph'

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-pwa-graph-'))
  await mkdir(join(root, 'assets'), { recursive: true })
  return root
}

describe('computePwaAssetClosure', () => {
  it('returns an empty set when remote.html is missing', async () => {
    const root = await makeRoot()
    expect(await computePwaAssetClosure(root)).toEqual(new Set())
  })

  it('collects every asset referenced by remote.html', async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, 'remote.html'),
      '<script type="module" src="./assets/entry-abc.js"></script>' +
        '<link rel="stylesheet" href="./assets/app-style.css">',
      'utf8'
    )
    await writeFile(join(root, 'assets', 'entry-abc.js'), 'export default 1;', 'utf8')
    await writeFile(join(root, 'assets', 'app-style.css'), 'body{}', 'utf8')
    const closure = await computePwaAssetClosure(root)
    expect(closure.has('/assets/entry-abc.js')).toBe(true)
    expect(closure.has('/assets/app-style.css')).toBe(true)
  })

  it('follows static and dynamic imports inside chunks (transitive)', async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, 'remote.html'),
      '<script type="module" src="./assets/entry-abc.js"></script>',
      'utf8'
    )
    await writeFile(
      join(root, 'assets', 'entry-abc.js'),
      'import { a } from "./shared-x.js";\nimport("./lazy-y.js").then(a);',
      'utf8'
    )
    await writeFile(
      join(root, 'assets', 'shared-x.js'),
      'import { b } from "./nested-z.js"; export const a = b;',
      'utf8'
    )
    await writeFile(join(root, 'assets', 'nested-z.js'), 'export const b = 1;', 'utf8')
    await writeFile(join(root, 'assets', 'lazy-y.js'), 'export default 2;', 'utf8')

    const closure = await computePwaAssetClosure(root)
    expect(closure).toEqual(
      new Set([
        '/assets/entry-abc.js',
        '/assets/shared-x.js',
        '/assets/nested-z.js',
        '/assets/lazy-y.js'
      ])
    )
  })

  it('never includes files that are not referenced', async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, 'remote.html'),
      '<script type="module" src="./assets/entry-abc.js"></script>',
      'utf8'
    )
    await writeFile(join(root, 'assets', 'entry-abc.js'), 'void 0;', 'utf8')
    await writeFile(join(root, 'assets', 'index-desktop.js'), 'void 0;', 'utf8')

    const closure = await computePwaAssetClosure(root)
    expect(closure.has('/assets/index-desktop.js')).toBe(false)
  })

  it('captures stylesheets listed in a Vite dependency array inside a chunk', async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, 'remote.html'),
      '<script type="module" src="./assets/entry-abc.js"></script>',
      'utf8'
    )
    // Vite emits modulepreload dep arrays like ["./x.js","./Comp-xyz.css"].
    await writeFile(
      join(root, 'assets', 'entry-abc.js'),
      'const deps = ["./shared-x.js","./Comp-xyz.css"]; void deps;',
      'utf8'
    )
    await writeFile(join(root, 'assets', 'shared-x.js'), 'export default 1;', 'utf8')
    await writeFile(join(root, 'assets', 'Comp-xyz.css'), 'body{color:red}', 'utf8')

    const closure = await computePwaAssetClosure(root)
    expect(closure.has('/assets/Comp-xyz.css')).toBe(true)
    expect(closure.has('/assets/shared-x.js')).toBe(true)
  })

  it('never treats a root-level file (e.g. service-worker.js) as an asset', async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, 'remote.html'),
      '<script type="module" src="./assets/entry-abc.js"></script>',
      'utf8'
    )
    await writeFile(join(root, 'assets', 'entry-abc.js'), 'void 0;', 'utf8')
    await writeFile(join(root, 'service-worker.js'), 'self.onfetch=()=>{}', 'utf8')

    const closure = await computePwaAssetClosure(root)
    expect(closure.has('/assets/service-worker.js')).toBe(false)
    expect(closure.has('/assets/entry-abc.js')).toBe(true)
  })
})

describe('computePwaAssetGraph', () => {
  it('classifies hashed build outputs as immutable and public icons as mutable', async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, 'remote.html'),
      '<script type="module" src="./assets/entry-abc.js"></script>',
      'utf8'
    )
    await writeFile(join(root, 'assets', 'entry-abc.js'), 'void 0;', 'utf8')
    await mkdir(join(root, 'assets/agents'), { recursive: true })
    await writeFile(join(root, 'assets/agents', 'openai.svg'), '<svg/>', 'utf8')

    const graph = await computePwaAssetGraph(root)
    expect(graph.immutable.has('/assets/entry-abc.js')).toBe(true)
    expect(graph.immutable.has('/assets/agents/openai.svg')).toBe(false)
    expect(graph.mutable.has('/assets/agents/openai.svg')).toBe(true)
    expect(graph.closure.has('/assets/entry-abc.js')).toBe(true)
    expect(graph.closure.has('/assets/agents/openai.svg')).toBe(true)
  })

  it('exposes a disconnected-shell precache manifest with root files first', async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, 'remote.html'),
      '<script type="module" src="./assets/entry-abc.js"></script>' +
        '<link rel="stylesheet" href="./assets/app-style.css">',
      'utf8'
    )
    await writeFile(join(root, 'assets', 'entry-abc.js'), 'void 0;', 'utf8')
    await writeFile(join(root, 'assets', 'app-style.css'), 'body{}', 'utf8')

    const graph = await computePwaAssetGraph(root)
    expect(graph.precache[0]).toBe('/remote.html')
    expect(graph.precache).toContain('/manifest.webmanifest')
    expect(graph.precache).toContain('/assets/entry-abc.js')
    expect(graph.precache).toContain('/assets/app-style.css')
  })

  it('computes gzip budget metadata for the initial remote JS closure', async () => {
    const root = await makeRoot()
    await writeFile(
      join(root, 'remote.html'),
      '<script type="module" src="./assets/entry-abc.js"></script>',
      'utf8'
    )
    await writeFile(
      join(root, 'assets', 'entry-abc.js'),
      'export const a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
      'utf8'
    )

    const graph = await computePwaAssetGraph(root)
    expect(graph.budget.chunks).toHaveLength(1)
    const chunk = graph.budget.chunks[0]
    expect(chunk?.url).toBe('/assets/entry-abc.js')
    expect(chunk?.rawBytes).toBeGreaterThan(chunk?.gzipBytes ?? 0)
    expect(chunk?.gzipBytes).toBeGreaterThan(0)
    expect(graph.budget.initialJsGzipBytes).toBe(chunk?.gzipBytes)
    expect(graph.budget.maxInitialChunkGzipBytes).toBe(chunk?.gzipBytes)
  })
})
