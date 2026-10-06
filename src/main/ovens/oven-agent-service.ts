import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  OVEN_PROTOCOL_VERSION,
  type OvenAgentDescriptor,
  type OvenAgentPreview,
  type OvenAgentRegistration,
  type OvenAgentRegistrationInput,
  type OvenAgentScript,
  type OvenAgentScriptRequest,
  type SaveOvenInput
} from '../../lib/ovens'
import type { OvenRegistry } from './oven-registry'
import { buildOvenAgentScript, normalizeServiceBundle } from './oven-agent-script'
import { decodeOvenAgentDescriptor, descriptorHasIdentity } from './oven-agent-descriptor'
import { Logger } from '../system/logger'

/** Default appearance for an Oven the app learned about from an agent. */
const AGENT_ICON = 'server'
const AGENT_COLOR = '#22c55e'

/**
 * Generate the standalone Oven agent installer and register machines that ran it.
 *
 * The app never has to be the one that prepares a machine: this service builds a
 * self-contained script from the same bundle the app pushes, and turns the
 * descriptor that script prints back into a saved Oven.
 */
export class OvenAgentService {
  private bundle: Promise<{ source: string; revision: string }> | undefined

  constructor(private readonly registry: OvenRegistry) {}

  /** Build the installer for one target platform family. */
  async script(request: OvenAgentScriptRequest): Promise<OvenAgentScript> {
    const { source, revision } = await this.loadBundle()
    return buildOvenAgentScript({
      platform: request.platform,
      identity: request.identity,
      bootstrapNode: request.bootstrapNode,
      service: source,
      serviceRevision: revision,
      protocolVersion: OVEN_PROTOCOL_VERSION
    })
  }

  /** Describe what a code will register, without storing anything. */
  async preview(code: string): Promise<OvenAgentPreview> {
    const descriptor = decodeOvenAgentDescriptor(code)
    const { revision } = await this.loadBundle()
    return this.previewOf(descriptor, revision)
  }

  /** Validate a descriptor and save it as an Oven, storing any identity in the vault. */
  async register(input: OvenAgentRegistrationInput): Promise<OvenAgentRegistration> {
    const descriptor = decodeOvenAgentDescriptor(input.code)
    const { revision } = await this.loadBundle()
    const preview = this.previewOf(descriptor, revision)
    const save = this.saveInputFor(descriptor, input)
    const oven = await this.registry.save(save)
    Logger.info('Registered an Oven from an agent descriptor', {
      ovenId: oven.id,
      platform: preview.platform,
      serviceCurrent: preview.serviceCurrent,
      identityImported: preview.identityPresent
    })
    return { oven, preview, identityImported: preview.identityPresent }
  }

  /**
   * Convert a descriptor into the exact save shape the registry already accepts.
   *
   * A provisioned identity becomes a vaulted key. Without one the Oven is saved
   * against the user's SSH agent, so the entry still exists and can be edited
   * rather than being rejected outright.
   */
  private saveInputFor(
    descriptor: OvenAgentDescriptor,
    input: OvenAgentRegistrationInput
  ): SaveOvenInput {
    const connection = {
      host: this.field(input.host, 'host') ?? descriptor.hostname,
      user: this.field(input.user, 'user') ?? descriptor.user,
      port: input.port ?? descriptor.port,
      authentication: descriptorHasIdentity(descriptor) ? ('vault' as const) : ('agent' as const)
    }
    const save: SaveOvenInput = {
      name: this.field(input.name, 'name') ?? descriptor.name,
      icon: AGENT_ICON,
      color: AGENT_COLOR,
      connection
    }
    if (descriptorHasIdentity(descriptor)) {
      save.privateKey = descriptor.identity.privateKey
      save.publicKey = descriptor.identity.publicKey
    }
    return save
  }

  private previewOf(descriptor: OvenAgentDescriptor, currentRevision: string): OvenAgentPreview {
    const identity = descriptor.identity
    return {
      host: descriptor.hostname,
      port: descriptor.port,
      user: descriptor.user,
      name: descriptor.name,
      platform: descriptor.platform,
      architecture: descriptor.architecture,
      hostname: descriptor.hostname,
      nodeVersion: descriptor.nodeVersion,
      serviceRevision: descriptor.serviceRevision,
      protocolVersion: descriptor.protocolVersion,
      identityPresent: identity !== undefined,
      ...(identity ? { identityFingerprint: fingerprint(identity.publicKey) } : {}),
      serviceCurrent:
        descriptor.protocolVersion === OVEN_PROTOCOL_VERSION &&
        descriptor.serviceRevision === currentRevision
    }
  }

  private field(value: string | undefined, label: string): string | undefined {
    if (value === undefined) return undefined
    const trimmed = value.trim()
    if (!trimmed) throw new TypeError(`Enter a ${label} for this Oven.`)
    return trimmed
  }

  private async loadBundle(): Promise<{ source: string; revision: string }> {
    this.bundle ??= (async () => {
      const source = normalizeServiceBundle(
        await readFile(join(app.getAppPath(), 'out/main/oven-service.mjs'), 'utf8')
      )
      return { source, revision: createHash('sha256').update(source).digest('hex') }
    })()
    return this.bundle
  }
}

/** SHA-256 fingerprint of an OpenSSH public key, the form `ssh-keygen -lf` prints. */
export function fingerprint(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/u)[1]
  if (!blob) return 'unknown'
  const digest = createHash('sha256')
    .update(Buffer.from(blob, 'base64'))
    .digest('base64')
    .replace(/=+$/u, '')
  return `SHA256:${digest}`
}
