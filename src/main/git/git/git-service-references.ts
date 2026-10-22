import type { SimpleGit } from 'simple-git'
import type { DanglingReference, GitIntegrationChanges } from '../../../lib/types'
import { posixBasename, toPosixPath } from '../../../lib/paths'
import { backgroundIo } from '../../system/background-io'

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.svelte', '.js', '.jsx', '.mjs', '.cjs']
const DEPENDENCY_MANIFESTS = ['package.json', 'bun.lock', 'bun.lockb']

/**
 * Compare the tree before and after an integration in one git call, so the
 * caller learns both what was removed and what was touched.
 */
export async function integrationChanges(
  git: SimpleGit,
  beforeSha: string | null,
  afterSha: string | null
): Promise<GitIntegrationChanges> {
  if (!beforeSha || !afterSha || beforeSha === afterSha) return { deleted: [], changed: [] }

  // `-z` keeps paths byte-exact (git would otherwise quote and escape anything
  // unusual), and `--no-renames` reports a rename as the deletion and the
  // addition it really is, so a moved file is still inspected as a removal.
  const output = await git.raw(['diff', '--name-status', '--no-renames', '-z', beforeSha, afterSha])

  const fields = output.split('\0').filter((field) => field.length > 0)
  const deleted: string[] = []
  const changed: string[] = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index] ?? ''
    const path = toPosixPath(fields[index + 1] ?? '')
    if (path === '') continue
    changed.push(path)
    if (status.startsWith('D')) deleted.push(path)
  }
  return { deleted, changed }
}

/** The dependency manifests an integration rewrote, if any. */
export function changedDependencyManifests(changes: GitIntegrationChanges): string[] {
  return changes.changed.filter((path) => DEPENDENCY_MANIFESTS.includes(posixBasename(path)))
}

/** Scan source and resolve imports in the bounded background worker. */
export async function findDanglingReferences(
  root: string,
  deletedPaths: readonly string[],
  git: SimpleGit
): Promise<DanglingReference[]> {
  if (deletedPaths.length === 0) return []
  return backgroundIo<DanglingReference[]>({
    kind: 'dangling-references',
    root,
    deletedPaths: [...deletedPaths],
    files: await trackedSourceFiles(git)
  })
}

/** The tracked source files of the checkout, as repo-relative POSIX paths. */
async function trackedSourceFiles(git: SimpleGit): Promise<string[]> {
  const output = await git.raw(['ls-files', '-z'])
  return output
    .split('\0')
    .map((path) => toPosixPath(path.trim()))
    .filter((path) => SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)))
}
