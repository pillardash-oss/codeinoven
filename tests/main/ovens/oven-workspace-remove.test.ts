/**
 * The Oven workspace `remove` operation: the one request that actually deletes a
 * file on a machine instead of parking it somewhere else.
 *
 * These run against a real temporary directory, because the operation's whole
 * value is that the bytes are gone: a fake would only prove the request was sent.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ovenWorkspace } from '../../../src/main/ovens/remote/oven-workspace'

/** One scratch root, removed whatever the test did with it. */
async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'cio-workspace-remove-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Whether a path is there, asked the way the Oven itself would answer. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

describe('oven workspace remove', () => {
  it('deletes one file inside the root', async () => {
    await withRoot(async (root) => {
      const file = join(root, 'sessions', '2026-01-01T00-00-00-000Z_session.jsonl')
      await mkdir(join(root, 'sessions'))
      await writeFile(file, '{"type":"session"}\n')

      await expect(
        ovenWorkspace({
          operation: 'remove',
          root,
          path: 'sessions/2026-01-01T00-00-00-000Z_session.jsonl'
        })
      ).resolves.toEqual({ root })
      expect(await exists(file)).toBe(false)
      // The directory the file lived in is untouched.
      expect(await exists(dirname(file))).toBe(true)
    })
  })

  it('refuses a directory', async () => {
    await withRoot(async (root) => {
      await mkdir(join(root, 'sessions'))
      await writeFile(join(root, 'sessions', 'kept.jsonl'), '{}\n')

      await expect(ovenWorkspace({ operation: 'remove', root, path: 'sessions' })).rejects.toThrow(
        'Only a file or symbolic link can be deleted on the Oven.'
      )
      // A refused delete changes nothing.
      expect(await exists(join(root, 'sessions', 'kept.jsonl'))).toBe(true)
    })
  })

  it('tolerates a file that is already gone', async () => {
    await withRoot(async (root) => {
      await expect(
        ovenWorkspace({ operation: 'remove', root, path: 'never-written.jsonl' })
      ).resolves.toEqual({ root })
    })
  })

  it('refuses a path that leaves the root before touching the disk', async () => {
    await withRoot(async (root) => {
      const outside = `${root}-outside`
      await writeFile(outside, 'keep me\n')
      try {
        await expect(
          ovenWorkspace({ operation: 'remove', root, path: `../${basename(outside)}` })
        ).rejects.toThrow('Path leaves the workspace.')
        expect(await exists(outside)).toBe(true)
      } finally {
        await rm(outside, { force: true })
      }
    })
  })
})
