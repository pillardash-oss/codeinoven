import { MEDIA_PROVIDER_IDS, MEDIA_PROVIDERS, isMediaProviderId } from '../../lib/media-generation'
import type { MediaGenerationState } from '../../lib/ipc/media'
import type { MediaProviderId } from '../../lib/media-generation'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import type { MediaGenerationService } from './media-generation-service'

/**
 * The settings boundary for the generation backend.
 *
 * Three channels and no more: read the state, store a token, forget a token. The
 * provider choice itself is an ordinary config field and travels over
 * `config:update` with every other preference, so it is validated once rather
 * than twice. The token is validated here and handed straight to the vault.
 */

/** Longest accepted token, so a pasted page cannot be stored as a credential. */
const TOKEN_MAX_LENGTH = 512

function requireProviderId(value: unknown): MediaProviderId {
  if (!isMediaProviderId(value)) {
    throw new TypeError(`Generation provider must be one of ${MEDIA_PROVIDER_IDS.join(', ')}`)
  }
  return value
}

/** A token as the vault will store it: non-empty, bounded, and free of control characters. */
function requireToken(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('The generation token must be a string')
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new TypeError('The generation token must not be empty')
  if (trimmed.length > TOKEN_MAX_LENGTH) throw new TypeError('The generation token is too long')
  // eslint-disable-next-line no-control-regex -- a credential never carries control bytes.
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new TypeError('The generation token must not contain control characters')
  }
  return trimmed
}

/** One state read, composed here so the service never imports IPC records. */
export async function mediaGenerationState(
  service: MediaGenerationService
): Promise<MediaGenerationState> {
  const status = await service.status()
  return {
    ...status,
    providers: MEDIA_PROVIDER_IDS.map((id) => ({
      id,
      label: MEDIA_PROVIDERS[id].label,
      keyUrl: MEDIA_PROVIDERS[id].keyUrl,
      description: MEDIA_PROVIDERS[id].description
    }))
  }
}

export function registerMediaGenerationIpc(service: MediaGenerationService): void {
  ipcMain.handle('mediaGeneration:state', () => mediaGenerationState(service))
  ipcMain.handle(
    'mediaGeneration:setToken',
    async (_event, rawProviderId: unknown, rawToken: unknown) => {
      await service.setToken(requireProviderId(rawProviderId), requireToken(rawToken))
      return mediaGenerationState(service)
    }
  )
  ipcMain.handle('mediaGeneration:clearToken', async (_event, rawProviderId: unknown) => {
    await service.clearToken(requireProviderId(rawProviderId))
    return mediaGenerationState(service)
  })
}
