import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { adoptLocalAiModel, moveModelInto } from '../../src/main/local-ai/local-ai-model-store'

/**
 * A downloaded model is moved out of the engine's cache into the app's own folder.
 *
 * The cache is scratch: `huggingface_hub` prunes nothing, and a snapshot is a
 * folder of symlinks into a blob store, so serving a model from it means depending
 * on a cleanup that is free to empty it. These tests cover the two properties the
 * move has to hold: the copy stands on its own, and the cache does not keep a
 * second copy of the same weights.
 */
async function scratchRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'cio-model-store-'))
}

/** A cache-shaped repository: blobs, and a snapshot of symlinks into them. */
async function cachedRepository(root: string): Promise<string> {
  const repository = join(root, 'hub', 'models--LiquidAI--LFM3-Omni-2B-MLX-8bit')
  const blobs = join(repository, 'blobs')
  const snapshot = join(repository, 'snapshots', 'abc123')
  await mkdir(blobs, { recursive: true })
  await mkdir(join(snapshot, 'audio_tokenizer'), { recursive: true })
  await writeFile(join(blobs, 'weights'), 'W'.repeat(4096))
  await symlink(join(blobs, 'weights'), join(snapshot, 'model.safetensors'))
  await writeFile(join(snapshot, 'config.json'), '{"model_type":"lfm3_omni"}')
  await writeFile(join(snapshot, 'audio_tokenizer', 'codec.bin'), 'CODEC')
  return snapshot
}

describe('adoptLocalAiModel', () => {
  it('moves a snapshot out of the cache and makes every weight a real file', async () => {
    const root = await scratchRoot()
    try {
      const snapshot = await cachedRepository(root)
      const models = join(root, 'local-models')

      const adopted = await adoptLocalAiModel(
        'LiquidAI/LFM3-Omni-2B-MLX-8bit',
        snapshot,
        models
      )

      expect(adopted).toBe(join(models, 'LiquidAI--LFM3-Omni-2B-MLX-8bit'))
      const weights = join(adopted ?? '', 'model.safetensors')
      expect((await stat(weights)).isFile()).toBe(true)
      expect((await readFile(weights, 'utf8')).length).toBe(4096)
      expect(await readFile(join(adopted ?? '', 'audio_tokenizer', 'codec.bin'), 'utf8')).toBe(
        'CODEC'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes the cache copy, and the repository with it once its last snapshot is gone', async () => {
    const root = await scratchRoot()
    try {
      const snapshot = await cachedRepository(root)
      const repository = join(root, 'hub', 'models--LiquidAI--LFM3-Omni-2B-MLX-8bit')

      await adoptLocalAiModel('LiquidAI/LFM3-Omni-2B-MLX-8bit', snapshot, join(root, 'models'))

      expect(existsSync(snapshot)).toBe(false)
      expect(existsSync(repository)).toBe(false)
      expect(await readdir(join(root, 'models'))).toEqual(['LiquidAI--LFM3-Omni-2B-MLX-8bit'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a repository name that is not owner/repo', async () => {
    const root = await scratchRoot()
    try {
      const snapshot = await cachedRepository(root)
      expect(await adoptLocalAiModel('not-a-repository', snapshot, join(root, 'models'))).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('moveModelInto', () => {
  it('places a single GGUF file in the target folder', async () => {
    const root = await scratchRoot()
    try {
      const file = join(root, 'cache', 'model.gguf')
      await mkdir(join(root, 'cache'), { recursive: true })
      await writeFile(file, 'GGUF')

      const target = join(root, 'models', 'LiquidAI--LFM2.5-2.6B-GGUF')
      await moveModelInto(file, target)

      expect(await readFile(join(target, 'model.gguf'), 'utf8')).toBe('GGUF')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
