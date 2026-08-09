import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import type {
  UtilityBundleInstallRequest,
  UtilityCredentialInput,
  UtilityDefinitionInput,
  UtilityDefinitionPatch,
  UtilityResolutionContext,
  UtilitySearchOptions
} from '../lib/types'
import { validateEntityId } from './ipc-validation'
import { SecretVault } from './secret-vault'
import type { StorageEngine } from './storage-engine'
import { UtilityRegistryService } from './utility-registry-service'
import { CuaBridgeService } from './cua-bridge-service'
import type { ComputerUsePipService } from './computer-use-pip-service'

/** Register the strict renderer boundary for utility configuration. */
export function registerUtilityIpc(
  storage: StorageEngine,
  registry = new UtilityRegistryService(storage),
  vault = new SecretVault(storage),
  cuaBridge = new CuaBridgeService(storage),
  pip?: ComputerUsePipService
): void {
  ipcMain.handle('computerUse:getCuaStatus', () => cuaBridge.getStatus())
  ipcMain.handle('computerUse:setCuaEnabled', (_, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new TypeError('Cua bridge enabled state is invalid')
    return cuaBridge.setEnabled(enabled)
  })
  ipcMain.handle('computerUse:pipGetState', () => pip?.getState() ?? { active: false })
  ipcMain.handle('computerUse:pipBringToFront', () => pip?.bringToFront() ?? Promise.resolve())
  ipcMain.handle('computerUse:pipDismiss', () => pip?.dismiss() ?? Promise.resolve())
  ipcMain.handle('utilities:list', async (_, options?: UtilitySearchOptions) => ({
    utilities: options ? await registry.search(options) : await registry.list(),
    secureStorageAvailable: vault.isAvailable()
  }))
  ipcMain.handle('utilities:get', (_, id: unknown) =>
    registry.get(validateEntityId(id, 'Utility ID', 256))
  )
  ipcMain.handle('utilities:create', (_, input: UtilityDefinitionInput) => registry.create(input))
  ipcMain.handle('utilities:installBundle', async (_, request: UtilityBundleInstallRequest) => {
    const bundle = validateBundleInstallRequest(request)
    const savedSecretRefs: string[] = []
    try {
      const definitions: UtilityDefinitionInput[] = []
      for (const entry of bundle.utilities) {
        const credentials = []
        for (const credential of entry.credentials ?? []) {
          const secretRef = await vault.save(credential.value)
          savedSecretRefs.push(secretRef)
          credentials.push({
            id: credential.id,
            label: credential.label,
            secretRef,
            required: credential.required,
            ...(credential.environmentVariable
              ? { environmentVariable: credential.environmentVariable }
              : {})
          })
        }
        definitions.push({ ...entry.definition, credentials })
      }
      return await registry.createMany(definitions)
    } catch (error) {
      for (const secretRef of savedSecretRefs.reverse()) {
        try {
          await vault.remove(secretRef)
        } catch {
          // Preserve the original installation failure.
        }
      }
      throw error
    }
  })
  ipcMain.handle('utilities:update', (_, id: unknown, patch: UtilityDefinitionPatch) =>
    registry.update(validateEntityId(id, 'Utility ID', 256), patch)
  )
  ipcMain.handle('utilities:delete', async (_, id: unknown) => {
    const safeId = validateEntityId(id, 'Utility ID', 256)
    const utility = await registry.get(safeId)
    if (!utility) return false
    for (const credential of utility.credentials) {
      await vault.remove(credential.secretRef)
    }
    return registry.delete(safeId)
  })
  ipcMain.handle(
    'utilities:setCredential',
    async (_, utilityId: unknown, input: UtilityCredentialInput) => {
      if (!isRecord(input)) throw new TypeError('Credential input must be an object')
      const safeUtilityId = validateEntityId(utilityId, 'Utility ID', 256)
      const utility = await registry.get(safeUtilityId)
      if (!utility) throw new Error(`Utility not found: ${safeUtilityId}`)
      const credentialId = validateEntityId(input?.id, 'Credential ID', 128)
      const label = validateText(input?.label, 'Credential label', 120)
      const value = validateText(input?.value, 'Credential value', 16_384, false)
      const environmentVariable =
        input.environmentVariable === undefined
          ? undefined
          : validateEnvironmentVariable(input.environmentVariable)
      if (typeof input.required !== 'boolean') {
        throw new TypeError('Credential required must be a boolean')
      }
      const current = utility.credentials.find((credential) => credential.id === credentialId)
      const secretRef = await vault.save(value, current?.secretRef)
      const credentials = utility.credentials.filter((credential) => credential.id !== credentialId)
      credentials.push({
        id: credentialId,
        label,
        secretRef,
        required: input.required,
        ...(environmentVariable ? { environmentVariable } : {})
      })
      return registry.update(safeUtilityId, { credentials })
    }
  )
  ipcMain.handle(
    'utilities:removeCredential',
    async (_, utilityId: unknown, credentialId: unknown) => {
      const safeUtilityId = validateEntityId(utilityId, 'Utility ID', 256)
      const safeCredentialId = validateEntityId(credentialId, 'Credential ID', 128)
      const utility = await registry.get(safeUtilityId)
      if (!utility) throw new Error(`Utility not found: ${safeUtilityId}`)
      const credential = utility.credentials.find((entry) => entry.id === safeCredentialId)
      if (!credential) return utility
      await vault.remove(credential.secretRef)
      return registry.update(safeUtilityId, {
        credentials: utility.credentials.filter((entry) => entry.id !== safeCredentialId)
      })
    }
  )
  ipcMain.handle('utilities:resolve', (_, context: UtilityResolutionContext) =>
    registry.resolve(context)
  )
}

function validateBundleInstallRequest(value: unknown): UtilityBundleInstallRequest {
  if (!isRecord(value)) throw new TypeError('Utility bundle must be an object')
  const name = validateText(value['name'], 'Utility bundle name', 120)
  const utilities = value['utilities']
  if (!Array.isArray(utilities) || utilities.length === 0 || utilities.length > 100) {
    throw new TypeError('Utility bundle must contain between 1 and 100 utilities')
  }
  return {
    name,
    utilities: utilities.map((entry, index) => {
      if (!isRecord(entry)) throw new TypeError(`Utility bundle entry ${index} must be an object`)
      const definition = entry['definition']
      assertBundleDefinition(definition, index)
      if (
        definition['credentials'] !== undefined &&
        (!Array.isArray(definition['credentials']) || definition['credentials'].length > 0)
      ) {
        throw new TypeError(
          `Utility bundle entry ${index} credentials must use the transient credentials field`
        )
      }
      const credentials = validateBundleCredentials(entry['credentials'], index)
      return {
        definition: { ...definition, credentials: [] },
        ...(credentials.length > 0 ? { credentials } : {})
      }
    })
  }
}

function assertBundleDefinition(
  value: unknown,
  entryIndex: number
): asserts value is UtilityDefinitionInput {
  if (!isRecord(value)) {
    throw new TypeError(`Utility bundle entry ${entryIndex} definition must be an object`)
  }
}

function validateBundleCredentials(value: unknown, entryIndex: number): UtilityCredentialInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError(`Utility bundle entry ${entryIndex} credentials are invalid`)
  }
  const ids = new Set<string>()
  return value.map((credential, credentialIndex) => {
    if (!isRecord(credential)) {
      throw new TypeError(
        `Utility bundle entry ${entryIndex} credential ${credentialIndex} must be an object`
      )
    }
    const id = validateEntityId(
      credential['id'],
      `Utility bundle entry ${entryIndex} credential ID`,
      128
    )
    if (ids.has(id)) {
      throw new TypeError(`Utility bundle entry ${entryIndex} has duplicate credential ID: ${id}`)
    }
    ids.add(id)
    const environmentVariable =
      credential['environmentVariable'] === undefined
        ? undefined
        : validateEnvironmentVariable(credential['environmentVariable'])
    if (typeof credential['required'] !== 'boolean') {
      throw new TypeError(
        `Utility bundle entry ${entryIndex} credential required must be a boolean`
      )
    }
    return {
      id,
      label: validateText(
        credential['label'],
        `Utility bundle entry ${entryIndex} credential label`,
        120
      ),
      value: validateText(
        credential['value'],
        `Utility bundle entry ${entryIndex} credential value`,
        16_384,
        false
      ),
      required: credential['required'],
      ...(environmentVariable ? { environmentVariable } : {})
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateText(value: unknown, label: string, maximumLength: number, trim = true): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const normalized = trim ? value.trim() : value
  if (!normalized || normalized.length > maximumLength || normalized.includes('\0')) {
    throw new TypeError(`${label} must be between 1 and ${maximumLength} characters`)
  }
  return normalized
}

function validateEnvironmentVariable(value: unknown): string {
  const name = validateText(value, 'Environment variable', 160)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new TypeError('Environment variable name is invalid')
  }
  return name
}
