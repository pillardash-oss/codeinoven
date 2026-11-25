import { describe, expect, it } from 'vitest'
import type { GitFileChange } from '../../../src/lib/types'
import {
  buildChangeTree,
  compressDirChain,
  dirExpansionKey,
  filesForNode,
  pathsForNode,
  sortTreeDirs,
  splitChangePath
} from '../../../src/renderer/lib/git-changes-tree'

function change(path: string, status: GitFileChange['status'] = 'modified'): GitFileChange {
  return { path, status, staged: false }
}

describe('buildChangeTree', () => {
  it('nests a path into folders with the file at its leaf', () => {
    const files = [change('apps/application/src/lib/journal.ts')]
    const tree = buildChangeTree(files)
    const apps = tree.dirs.get('apps')

    expect(sortTreeDirs(tree.dirs).map((dir) => dir.name)).toEqual(['apps'])
    expect(apps?.path).toBe('apps')
    expect(filesForNode(tree)).toEqual(files)
    expect(pathsForNode(tree)).toEqual(['apps/application/src/lib/journal.ts'])
  })

  it('keeps a file that sits directly in the section root at the root', () => {
    const files = [change('package.json')]
    const tree = buildChangeTree(files)
    expect(tree.files.map((file) => file.path)).toEqual(['package.json'])
    expect(tree.dirs.size).toBe(0)
  })
})

describe('compressDirChain', () => {
  it('folds a chain of single-child folders into one row', () => {
    const tree = buildChangeTree([change('apps/application/src/lib/journal.ts')])
    const apps = tree.dirs.get('apps')
    const row = compressDirChain(apps as NonNullable<typeof apps>)

    expect(row.label).toBe('apps/application/src/lib')
    // The row names the chain but opens the deepest node, so the count and the
    // files below it are the same ones the unfolded tree showed.
    expect(row.node.path).toBe('apps/application/src/lib')
    expect(filesForNode(row.node)).toHaveLength(1)
  })

  it('stops at a folder that holds files of its own', () => {
    // `lib` holds a file and a subdirectory, so its name cannot be swallowed by
    // the chain above it: the file has to stay under the name it is known by.
    const tree = buildChangeTree([
      change('apps/application/lib/index.ts'),
      change('apps/application/lib/deep/x.ts')
    ])
    const apps = tree.dirs.get('apps')
    const row = compressDirChain(apps as NonNullable<typeof apps>)

    expect(row.label).toBe('apps/application/lib')
    expect(row.node.path).toBe('apps/application/lib')
    expect(row.node.files.map((file) => file.path)).toEqual(['apps/application/lib/index.ts'])
    expect(sortTreeDirs(row.node.dirs).map((dir) => dir.name)).toEqual(['deep'])
  })

  it('stops at a branch, leaving each side visible', () => {
    const tree = buildChangeTree([change('apps/lib/a.ts'), change('apps/test/b.ts')])
    const apps = tree.dirs.get('apps')
    const row = compressDirChain(apps as NonNullable<typeof apps>)

    expect(row.label).toBe('apps')
    expect(sortTreeDirs(row.node.dirs).map((dir) => dir.name)).toEqual(['lib', 'test'])
  })

  it('keeps a single folder that only holds files as it is', () => {
    const tree = buildChangeTree([change('src/a.ts'), change('src/b.ts')])
    const src = tree.dirs.get('src')
    const row = compressDirChain(src as NonNullable<typeof src>)

    expect(row.label).toBe('src')
    expect(row.node.files).toHaveLength(2)
  })
})

describe('splitChangePath', () => {
  it('separates the file name from the folders that qualify it', () => {
    expect(splitChangePath('apps/application/src/journal.ts')).toEqual({
      name: 'journal.ts',
      dir: 'apps/application/src'
    })
  })

  it('leaves a root file with no folders to name', () => {
    expect(splitChangePath('package.json')).toEqual({ name: 'package.json', dir: '' })
  })

  it('keeps a dotfile whole, including its leading dot', () => {
    expect(splitChangePath('.github/workflows/ci.yml')).toEqual({
      name: 'ci.yml',
      dir: '.github/workflows'
    })
    expect(splitChangePath('apps/.env')).toEqual({ name: '.env', dir: 'apps' })
  })
})

describe('dirExpansionKey', () => {
  it('keeps one folder open per section, not per path', () => {
    // The same directory is listed under Unstaged and Untracked at once; folding
    // it in one section used to fold the other, because the key was the path.
    const unstaged = dirExpansionKey('Unstaged', 'apps')
    const untracked = dirExpansionKey('Untracked', 'apps')

    expect(unstaged).not.toBe(untracked)
    expect(dirExpansionKey('Unstaged', 'apps')).toBe(unstaged)
  })
})
