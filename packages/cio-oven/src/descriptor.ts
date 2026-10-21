import { mkdir, writeFile } from 'node:fs/promises'
import { hostname, userInfo } from 'node:os'
import { dirname } from 'node:path'
import {
  OVEN_AGENT_DESCRIPTOR_VERSION,
  OVEN_PROTOCOL_VERSION,
  type OvenAgentDescriptor,
  type OvenAgentIdentity,
  type OvenAgentPlatform
} from '../../../src/lib/ovens'
import { encodeOvenAgentDescriptor } from '../../../src/main/ovens/oven-agent-descriptor'
import { candidateAddresses } from './addresses'
import type { OvenLayout } from './paths'

export interface DescriptorInput {
  name: string
  port: number
  user: string
  dataRoot: string
  serviceRevision: string
  identity?: OvenAgentIdentity
}

/** The host name the app should dial when the user does not supply one. */
export function defaultName(): string {
  return hostname()
}

/** The SSH account the app should log in as. */
export function currentUser(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? userInfo().username
}

/**
 * The platform family a machine belongs to, as the app names Ovens.
 *
 * Android is not a separate family here: Termux is a Linux userspace with a
 * POSIX shell, npm, and the same command set as any other Oven, and only the
 * runtime's own name differs. npm also reads `process.platform` when it applies
 * a package's `os` field, which is why the published package lists `android`
 * and this maps it to the Linux plan.
 */
export function agentPlatformFor(platform: string): OvenAgentPlatform {
  if (platform === 'android') return 'linux'
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32') return platform
  throw new Error(
    `CodeInOven supports Linux, macOS, Windows, and Termux on Android Ovens. This machine reports ${platform}.`
  )
}

/** The platform family this machine belongs to, rejecting one the app cannot set up. */
export function agentPlatform(): OvenAgentPlatform {
  return agentPlatformFor(process.platform)
}

/**
 * Assemble the descriptor the app reads from a pasted registration code.
 *
 * It is the same shape the in-app agent installer produces, so both paths land
 * on one registration screen with one validation rule.
 */
export function buildDescriptor(input: DescriptorInput): OvenAgentDescriptor {
  return {
    kind: 'codeinoven-oven-agent',
    version: OVEN_AGENT_DESCRIPTOR_VERSION,
    protocolVersion: OVEN_PROTOCOL_VERSION,
    serviceRevision: input.serviceRevision,
    platform: agentPlatform(),
    architecture: process.arch,
    hostname: defaultName(),
    addresses: candidateAddresses(),
    user: input.user,
    port: input.port,
    name: input.name,
    dataRoot: input.dataRoot,
    nodeVersion: process.versions.node,
    ...(input.identity ? { identity: input.identity } : {}),
    createdAt: Date.now()
  }
}

/** The single-line code a user pastes into the app. */
export function registrationCode(descriptor: OvenAgentDescriptor): string {
  return encodeOvenAgentDescriptor(descriptor)
}

/** Save a copy of the descriptor beside the service, owner-readable only. */
export async function writeRegistration(
  layout: OvenLayout,
  descriptor: OvenAgentDescriptor
): Promise<void> {
  await mkdir(dirname(layout.registrationFile), { recursive: true, mode: 0o700 })
  await writeFile(
    layout.registrationFile,
    `${JSON.stringify(descriptor, null, 2)}\n`,
    process.platform === 'win32' ? {} : { mode: 0o600 }
  )
}
