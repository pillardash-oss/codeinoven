import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { RepositoryService } from '../../src/main/repository-service'

const temporaryPaths: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'codeinoven-repository-'))
  temporaryPaths.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('RepositoryService', () => {
  it('detects a folder that is not tracked by Git', async () => {
    const projectPath = await temporaryDirectory()
    const canonicalPath = await realpath(projectPath)
    const result = await new RepositoryService().preflight(projectPath)

    expect(result.status).toBe('not_git')
    expect(result.projectPath).toBe(canonicalPath)
  })

  it('initializes Git tracking and reports the repository root', async () => {
    const projectPath = await temporaryDirectory()
    const canonicalPath = await realpath(projectPath)
    const result = await new RepositoryService().initialize(projectPath)

    expect(result.status).toBe('git')
    expect(result.repositoryRoot).toBe(canonicalPath)
  })

  it('rejects paths that are not directories', async () => {
    const directory = await temporaryDirectory()
    const filePath = join(directory, 'file.txt')
    await writeFile(filePath, 'not a directory', 'utf-8')

    await expect(new RepositoryService().preflight(filePath)).rejects.toThrow(
      'Project path is not a directory'
    )
  })
})
