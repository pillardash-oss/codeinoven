import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computePwaAssetClosure } from './pwa-asset-graph'

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
})
