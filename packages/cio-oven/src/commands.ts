import { connect } from 'node:net'
import { readFile } from 'node:fs/promises'
import { OVEN_PROTOCOL_VERSION } from '../../../src/lib/ovens'
import {
  buildDescriptor,
  currentUser,
  defaultName,
  registrationCode,
  writeRegistration
} from './descriptor'
import { identityKeyPath, ovenLayout, type OvenLayout } from './paths'
import { provisionIdentity, readIdentity, type IdentityResult } from './identity'
import {
  ensureService,
  installBundle,
  probeService,
  readBundle,
  serviceState,
  stopService
} from './service'
import { askConfirm, askPort, askText, promptsAvailable } from './prompt'
import { candidateAddresses } from './addresses'
import { blank, code as copyBlock, fail, field, note, out, section, step, warn } from './output'

/** The oldest Node the Oven service runs on, matching the app's own requirement. */
const MINIMUM_NODE = 22
/** The port SSH uses unless the machine is configured otherwise. */
const DEFAULT_SSH_PORT = 22

export interface CommonOptions {
  dataRoot: string
  json: boolean
}

export interface StartOptions extends CommonOptions {
  name?: string
  port?: number
  /** `undefined` asks, because the choice belongs to the user. */
  identity?: boolean
  yes: boolean
  force: boolean
}

function requireNode(): void {
  const major = Number(process.versions.node.split('.')[0])
  if (!Number.isSafeInteger(major) || major < MINIMUM_NODE)
    fail(
      `CodeInOven Ovens need Node.js ${MINIMUM_NODE} or later. This machine runs ${process.versions.node}.`
    )
}

/** The port `sshd` is configured on, when the machine lets us read the file. */
async function detectSshPort(): Promise<number | null> {
  const candidates =
    process.platform === 'win32'
      ? [`${process.env['ProgramData'] ?? 'C:\\ProgramData'}\\ssh\\sshd_config`]
      : ['/etc/ssh/sshd_config']
  for (const file of candidates) {
    try {
      const match = /^\s*Port\s+(\d+)\s*$/mu.exec(await readFile(file, 'utf8'))
      const port = match ? Number(match[1]) : Number.NaN
      if (Number.isSafeInteger(port) && port >= 1 && port <= 65535) return port
    } catch {
      /* No readable sshd config on this platform. */
    }
  }
  return null
}

/** Whether anything accepts a TCP connection on one host and port. */
function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(3000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Whether this machine is actually serving SSH on a port.
 *
 * Loopback is the fast path, but `sshd` can be bound to one interface only, so
 * the machine's own addresses are tried too rather than declaring a live server
 * dead. A port is only reported as serving when something really answers on it.
 */
async function sshServing(port: number): Promise<boolean> {
  if (await portOpen('127.0.0.1', port)) return true
  for (const host of candidateAddresses()) if (await portOpen(host, port)) return true
  return false
}

/**
 * The ports worth dialling for SSH, most specific claim first.
 *
 * The reported port leads because it is the more specific claim, and the
 * standard one follows so a wrong answer still finds the live server.
 */
export function sshPortCandidates(preferred: number | null): number[] {
  return [...new Set([preferred, DEFAULT_SSH_PORT])].filter(
    (port): port is number =>
      port !== null && Number.isSafeInteger(port) && port >= 1 && port <= 65535
  )
}

/**
 * The port SSH is really served on, among the candidate ports.
 *
 * A port the user typed is a claim the machine cannot check from the outside:
 * unless `sshd` is configured for it, the app saves it and every later
 * connection times out. Here it is settled where the truth is available.
 * Returns null when nothing is serving SSH on any candidate, and the caller is
 * expected to refuse rather than publish an endpoint that can only fail.
 */
export async function resolveServingSshPort(
  preferred: number | null,
  serving: (port: number) => Promise<boolean>
): Promise<number | null> {
  for (const port of sshPortCandidates(preferred)) if (await serving(port)) return port
  return null
}

/** The port SSH is really served on, among the ports worth trying. */
async function servingSshPort(preferred: number | null): Promise<number | null> {
  return resolveServingSshPort(preferred, sshServing)
}

/** What to do when the machine is not serving SSH on the port that was chosen. */
function sshUnavailable(port: number): string {
  const config =
    process.platform === 'win32' ? 'C:\\ProgramData\\ssh\\sshd_config' : '/etc/ssh/sshd_config'
  const restart =
    process.platform === 'win32' ? 'Restart-Service sshd' : 'sudo systemctl restart sshd'
  return [
    `Nothing is serving SSH on port ${port} on this machine, so a registration code now would only time out later.`,
    `Install the OpenSSH server if it is missing, set "Port ${port}" in ${config}, allow that port through the firewall, then run: ${restart}`,
    'Then run this command again.'
  ].join(' ')
}

interface ResolvedInputs {
  name: string
  port: number
  identity: boolean
}

async function resolveInputs(options: StartOptions): Promise<ResolvedInputs> {
  const attachable = promptsAvailable() && !options.yes
  if (!attachable && !options.yes && options.name === undefined)
    note(
      'No terminal is attached, so the default answers are used. Pass --yes to choose them explicitly.'
    )
  const name =
    options.name ?? (attachable ? await askText('Oven name', defaultName()) : defaultName())
  let port = options.port
  if (port === undefined) {
    const configured = await detectSshPort()
    // Offer the port something is really serving on. The sshd configuration is
    // the machine's own claim; a live listener is the fact, and the fact wins.
    const offered = (await servingSshPort(configured)) ?? configured ?? DEFAULT_SSH_PORT
    if (attachable) {
      if (offered === DEFAULT_SSH_PORT && configured === null)
        note(
          'No SSH server or configuration was found, so port 22 is offered. Change it if needed.'
        )
      port = await askPort('SSH port the app should connect on', offered)
    } else port = offered
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    fail('The SSH port must be between 1 and 65535.')
  const identity =
    options.identity ??
    (attachable ? await askConfirm('Provision a dedicated SSH key for this Oven?', true) : true)
  return { name, port, identity }
}

/**
 * Save the registration descriptor and print the connection summary.
 *
 * One code is produced for both the freshly started and the already-running
 * paths, so what the user copies always matches what is stored on disk.
 */
async function publish(
  layout: OvenLayout,
  inputs: ResolvedInputs,
  serviceRevision: string,
  protocolVersion: number,
  identity: IdentityResult | null
): Promise<void> {
  const descriptor = buildDescriptor({
    name: inputs.name,
    port: inputs.port,
    user: currentUser(),
    dataRoot: layout.dataRoot,
    serviceRevision,
    ...(identity
      ? {
          identity: {
            algorithm: 'ed25519' as const,
            privateKey: identity.privateKey,
            publicKey: identity.publicKey
          }
        }
      : {})
  })
  await writeRegistration(layout, descriptor)
  section('Oven ready')
  field('Name', descriptor.name)
  field('Host', descriptor.hostname)
  field('Addresses', (descriptor.addresses ?? []).join(', '))
  field('User', descriptor.user)
  field('SSH port', String(descriptor.port))
  field('Data root', layout.dataRoot)
  field('Node', descriptor.nodeVersion)
  field('Protocol', String(protocolVersion))
  field('Identity', identity ? `${identity.fingerprint} (${identity.keyPath})` : 'SSH agent')
  section('Register it in CodeInOven')
  note('Open Settings, then Ovens, then Add via agent, and paste this code:')
  copyBlock(registrationCode(descriptor))
  note(`A copy is saved at ${layout.registrationFile}`)
  note('Then open the Oven and run its setup to install the harnesses you want.')
  blank()
}

/**
 * Prepare this machine and start the durable Oven service.
 *
 * Re-running is safe by design: a service already on the shipped revision is
 * reused instead of restarted, and an existing dedicated key is reused rather
 * than replaced, so an Oven already registered with the app stays registered.
 */
export async function start(options: StartOptions): Promise<void> {
  requireNode()
  const layout = ovenLayout(options.dataRoot)
  const bundle = await readBundle()
  const inputs = await resolveInputs(options)

  // Settle the port against what the machine actually serves before anything is
  // installed or published. A code for a port nothing answers on is worse than
  // no code: it registers an Oven that can only time out.
  const serving = await servingSshPort(inputs.port)
  if (serving === null) fail(sshUnavailable(inputs.port))
  if (serving !== inputs.port) {
    warn(
      `Nothing is serving SSH on port ${inputs.port}, but port ${serving} answers. Using ${serving}.`
    )
    inputs.port = serving
  }

  const before = await serviceState(layout)

  if (before.running && !options.force) {
    const restart =
      promptsAvailable() && !options.yes
        ? await askConfirm('An Oven service is already running here. Restart it?', false)
        : false
    if (!restart) {
      const revision = before.probe?.serviceRevision ?? bundle.revision
      if (revision !== bundle.revision)
        warn(
          'The running Oven service was installed by a different release. Run start with --force to replace it.'
        )
      await publish(
        layout,
        inputs,
        revision,
        before.probe?.protocolVersion ?? OVEN_PROTOCOL_VERSION,
        inputs.identity ? await readIdentity(identityKeyPath()) : null
      )
      return
    }
    if ((before.probe?.activeRuns ?? 0) > 0)
      fail('Runs are still active on this Oven. Finish them, then start again.')
  }

  const identity = inputs.identity ? await provisionIdentity(identityKeyPath()) : null
  if (identity) {
    step(
      identity.created
        ? `Created a dedicated SSH key at ${identity.keyPath}.`
        : `Reusing the dedicated SSH key at ${identity.keyPath}.`
    )
    if (identity.warning) warn(identity.warning)
  } else step('No dedicated key: the app will connect with your existing SSH identity.')

  step('Installing the Oven service bundle.')
  await installBundle(layout, bundle)

  step('Starting the Oven service in the background.')
  const probe = await ensureService(layout, bundle)

  await publish(
    layout,
    inputs,
    probe.serviceRevision || bundle.revision,
    probe.protocolVersion || OVEN_PROTOCOL_VERSION,
    identity
  )
}

/** Stop the durable Oven service. */
export async function stop(options: CommonOptions): Promise<void> {
  const layout = ovenLayout(options.dataRoot)
  const result = await stopService(layout)
  if (options.json) {
    out(
      JSON.stringify({ running: false, stopped: result === 'stopped', dataRoot: layout.dataRoot })
    )
    return
  }
  if (result === 'stopped') step('The Oven service has stopped.')
  else step('No Oven service was running here.')
}

/** Report what this machine currently runs. */
export async function status(options: CommonOptions): Promise<void> {
  const layout = ovenLayout(options.dataRoot)
  const state = await serviceState(layout)
  if (options.json) {
    out(
      JSON.stringify({
        installed: state.installed,
        running: state.running,
        pid: state.pid,
        dataRoot: layout.dataRoot,
        probe: state.probe
      })
    )
    return
  }
  section('Oven service')
  field('Data root', layout.dataRoot)
  field('Installed', state.installed ? 'yes' : 'no')
  field('Running', state.running ? 'yes' : 'no')
  if (state.pid) field('Process', String(state.pid))
  if (state.probe) {
    field('Revision', state.probe.serviceRevision)
    field('Protocol', String(state.probe.protocolVersion))
    field('Platform', `${state.probe.platform} ${state.probe.architecture}`)
    field('Active runs', String(state.probe.activeRuns))
  }
  blank()
}

/** Replace the running service with this release without changing registration. */
export async function restart(options: StartOptions): Promise<void> {
  await stopService(ovenLayout(options.dataRoot)).catch(() => undefined)
  await start({ ...options, force: true })
}

/** The live probe, for callers that need it without printing anything. */
export async function currentProbe(dataRoot: string): Promise<unknown> {
  return probeService(ovenLayout(dataRoot))
}
