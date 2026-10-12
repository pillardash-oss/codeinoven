import { constants, access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'

const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/

/**
 * Filesystem layout for the Search (intent) subsystem, all beneath the app
 * config root so nothing is ever written into a user's repository:
 *
 *   <config-root>/search/
 *     models/<model-id>/       installed model files
 *     models/index.json        installed-model ledger
 *     staging/                 in-flight downloads
 *     index/thread-index.bin   the thread embedding index
 *     settings.json            enabled flag + active model id
 */
export class SearchStorage {
  readonly root: string
  readonly modelsDir: string
  readonly stagingDir: string
  readonly indexDir: string
  readonly settingsPath: string
  readonly modelIndexPath: string

  constructor(root = join(getConfigRoot(), 'search')) {
    this.root = root
    this.modelsDir = join(root, 'models')
    this.stagingDir = join(root, 'staging')
    this.indexDir = join(root, 'index')
    this.settingsPath = join(root, 'settings.json')
    this.modelIndexPath = join(this.modelsDir, 'index.json')
  }

  get threadIndexPath(): string {
    return join(this.indexDir, 'thread-index.bin')
  }

  get summaryDirectory(): string {
    return join(this.indexDir, 'thread-summaries')
  }

  async initialize(): Promise<void> {
    await mkdir(this.modelsDir, { recursive: true })
    await mkdir(this.stagingDir, { recursive: true })
    await mkdir(this.indexDir, { recursive: true })
  }

  /** Directory a single installed model owns. Rejects unsafe ids. */
  modelDirectory(modelId: string): string {
    if (!MODEL_ID_PATTERN.test(modelId)) throw new Error('Invalid search model id.')
    return join(this.modelsDir, modelId)
  }

  stagingFile(name: string): string {
    if (!MODEL_ID_PATTERN.test(name) && !/^[a-z0-9][a-z0-9._-]{2,200}$/.test(name)) {
      throw new Error('Invalid staging file name.')
    }
    return join(this.stagingDir, name)
  }

  async exists(path: string): Promise<boolean> {
    return access(path, constants.F_OK)
      .then(() => true)
      .catch(() => false)
  }
}
