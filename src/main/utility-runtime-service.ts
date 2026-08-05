import { randomUUID } from 'crypto'
import { isAbsolute, join, normalize, sep } from 'path'
import type { StorageEngine } from './storage-engine'
import type {
  PreparedUtilityRuntime,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from './drivers/driver.interface'

const RUNTIME_DIRECTORY = join('runtime', 'utilities')
const MANIFEST_FILE = 'activation.json'

interface UtilityRuntimeManifest {
  id: string
  projectPath: string
  utilities: Array<{
    id: string
    kind: string
    bindingStrategy: string
    transportName?: string
  }>
  environmentKeys: string[]
  argumentCount: number
  allowedTools: string[]
  configFiles: Array<{ id: string; relativePath: string }>
  createdAt: number
}

/**
 * Owns short-lived, provider-neutral launch overlays for utility activation.
 * It never writes harness configuration into the user's project.
 */
export class UtilityRuntimeService {
  private activeCleanups = new Map<string, () => Promise<void>>()

  constructor(private readonly storage: StorageEngine) {}

  async prepare(
    request: UtilityRuntimePreparationRequest,
    overlay: UtilityRuntimeOverlay = {}
  ): Promise<PreparedUtilityRuntime> {
    const id = randomUUID()
    const relativeDirectory = join(RUNTIME_DIRECTORY, id)
    const materializedConfigPaths = new Map<string, string>()
    const env = { ...(overlay.env ?? {}) }
    const args = [...(overlay.args ?? [])]
    const allowedTools = [...new Set(overlay.allowedTools ?? [])]
    const configFiles = overlay.configFiles ?? []

    this.validateConfigFiles(configFiles)
    await this.storage.ensureDirectory(relativeDirectory)

    let cleanupPromise: Promise<void> | null = null
    const cleanup = async (): Promise<void> => {
      cleanupPromise ??= this.storage
        .remove(relativeDirectory)
        .finally(() => this.activeCleanups.delete(id))
      await cleanupPromise
    }
    this.activeCleanups.set(id, cleanup)

    try {
      for (const configFile of configFiles) {
        const relativePath = join(relativeDirectory, 'config', configFile.relativePath)
        await this.storage.writeRaw(relativePath, configFile.content)
        materializedConfigPaths.set(configFile.id, this.storage.resolve(relativePath))
      }

      const manifest: UtilityRuntimeManifest = {
        id,
        projectPath: request.projectPath,
        utilities: request.resolvedUtilities.map(({ utility, binding }) => ({
          id: utility.id,
          kind: utility.kind,
          bindingStrategy: binding.strategy,
          ...(binding.transportName ? { transportName: binding.transportName } : {})
        })),
        environmentKeys: Object.keys(env).sort(),
        argumentCount: args.length,
        allowedTools,
        configFiles: configFiles.map(({ id: configId, relativePath }) => ({
          id: configId,
          relativePath
        })),
        createdAt: Date.now()
      }
      const relativeManifestPath = join(relativeDirectory, MANIFEST_FILE)
      await this.storage.write(relativeManifestPath, manifest)

      return {
        id,
        directory: this.storage.resolve(relativeDirectory),
        manifestPath: this.storage.resolve(relativeManifestPath),
        env,
        args,
        configPaths: Object.fromEntries(materializedConfigPaths),
        allowedTools,
        cleanup
      }
    } catch (error) {
      await cleanup()
      throw error
    }
  }

  /** Remove every runtime overlay still owned by this service. */
  async dispose(): Promise<void> {
    const cleanups = [...this.activeCleanups.values()]
    await Promise.all(cleanups.map((cleanup) => cleanup()))
  }

  private validateConfigFiles(files: NonNullable<UtilityRuntimeOverlay['configFiles']>): void {
    const ids = new Set<string>()
    const paths = new Set<string>()
    for (const file of files) {
      if (!file.id.trim()) throw new TypeError('Utility runtime config file ID is required')
      if (ids.has(file.id)) {
        throw new TypeError(`Duplicate utility runtime config file ID: ${file.id}`)
      }
      ids.add(file.id)

      const relativePath = normalize(file.relativePath)
      const pathSegments = file.relativePath.split(/[\\/]/u)
      if (
        !file.relativePath.trim() ||
        file.relativePath.includes('\0') ||
        isAbsolute(file.relativePath) ||
        /^[a-z]:[\\/]/iu.test(file.relativePath) ||
        pathSegments.includes('..') ||
        relativePath === '..' ||
        relativePath.startsWith(`..${sep}`) ||
        relativePath.startsWith(sep)
      ) {
        throw new TypeError(`Invalid utility runtime config path: ${file.relativePath}`)
      }
      if (paths.has(relativePath)) {
        throw new TypeError(`Duplicate utility runtime config path: ${file.relativePath}`)
      }
      paths.add(relativePath)
    }
  }
}
