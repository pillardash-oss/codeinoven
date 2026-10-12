import { copyFile, cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SearchStorage } from './search-storage'

export interface ImportProbe {
  /** Output dimensionality of the model, discovered by running it once. */
  dimensions: number
  /**
   * Usable context window. `0` means "defer to the model's own metadata", which
   * is the only honest answer for a model we did not convert ourselves.
   */
  contextTokens: number
}

export interface ImportedSearchModelFile {
  modelId: string
  directory: string
  byteSize: number
  dimensions: number
  contextTokens: number
  label: string
}

/**
 * Installs a user-provided embedding model into the Search models directory.
 *
 * Compatibility is proven, not assumed: the model is copied in, run once
 * through the embedding runtime, and rejected (leaving nothing behind) if it
 * cannot produce a vector. The runtime itself decides what "compatible" means
 * for its format.
 */
export class SearchModelImporter {
  constructor(
    private readonly storage: SearchStorage,
    private readonly probe: (directory: string) => Promise<ImportProbe>
  ) {}

  async importFromPath(sourcePath: string): Promise<ImportedSearchModelFile> {
    const source = await stat(sourcePath).catch(() => null)
    if (!source) throw new Error('The selected path does not exist.')
    const isDirectory = source.isDirectory()
    if (!isDirectory && !source.isFile()) {
      throw new Error('The selected path is neither a file nor a folder.')
    }
    if (isDirectory) {
      await assertContainsGguf(sourcePath)
    } else {
      assertGgufName(sourcePath)
      await assertGgufMagic(sourcePath)
    }

    const modelId = uniqueModelId(sourcePath)
    const directory = this.storage.modelDirectory(modelId)
    await mkdir(this.storage.modelsDir, { recursive: true })
    try {
      if (isDirectory) {
        await cp(sourcePath, directory, { recursive: true })
      } else {
        await mkdir(directory, { recursive: true })
        await copyFile(sourcePath, join(directory, basename(sourcePath)))
      }
      const probe = await this.probe(directory)
      const byteSize = await directoryByteSize(directory)
      return {
        modelId,
        directory,
        byteSize,
        dimensions: probe.dimensions,
        contextTokens: probe.contextTokens,
        label: basename(sourcePath)
      }
    } catch (cause) {
      // A rejected model must not leave a half-installed directory behind.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      throw cause instanceof Error ? cause : new Error('The model could not be imported.')
    }
  }
}

function assertGgufName(path: string): void {
  if (extname(path).toLowerCase() !== '.gguf') {
    throw new Error('Only GGUF embedding models can be imported as a single file.')
  }
}

async function assertContainsGguf(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = entries.some(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')
  )
  if (!found) throw new Error('The folder does not contain a GGUF embedding model.')
}

/** GGUF files begin with the ASCII magic "GGUF". */
async function assertGgufMagic(path: string): Promise<void> {
  const handle = await readFile(path)
  if (
    handle.length < 4 ||
    handle[0] !== 0x47 ||
    handle[1] !== 0x47 ||
    handle[2] !== 0x55 ||
    handle[3] !== 0x46
  ) {
    throw new Error('The selected file is not a GGUF model.')
  }
}

function uniqueModelId(sourcePath: string): string {
  const raw = basename(sourcePath, extname(sourcePath))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .slice(0, 96)
  const base = raw.length >= 3 ? raw : `imported-${raw}`
  return `${base}-${randomUUID().slice(0, 8)}`
}

async function directoryByteSize(directory: string): Promise<number> {
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        const info = await stat(full)
        total += info.size
      }
    }
  }
  await walk(directory)
  return total
}
