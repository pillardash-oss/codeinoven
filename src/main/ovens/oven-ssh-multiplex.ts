import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/** The slice of the storage engine these helpers need: a path resolver. */
export interface MultiplexStorage {
  resolve: (relativePath: string) => string
}

/**
 * One shared SSH connection per Oven, reused across the whole app.
 *
 * A plain `ssh` invocation pays a full TCP connect, key exchange, and
 * authentication before the remote command even starts, and the Oven transport
 * runs one invocation per command. A live turn polls `events` about once a
 * second, so it paid a full handshake roughly every second. Measured on a
 * loopback Oven, ten fresh invocations cost 0.76s against 0.14s for the same ten
 * multiplexed, and a real Oven across a network pays a full handshake on top of
 * that round trip each time.
 *
 * OpenSSH connection multiplexing already implements the principle the harness
 * servers use, so the app does not rebuild it. `ControlMaster=auto` promotes the
 * first invocation to a master that every later invocation shares, no matter
 * which transport or thread started it, so one connection serves the whole app.
 * `ControlPersist` is the watchdog: the master stays up while any command is
 * using it, and is closed only after the last one finishes and it then sits idle
 * for the TTL below. A turn polling every second never lets it idle, so the
 * connection is retained while a thread needs it and released once none do.
 */

/** Idle lifetime after the last command, mirroring the harness idle reapers. */
const IDLE_PERSIST_SECONDS = 300

const CONTROL_DIRECTORY = 'ovens/control'

/**
 * The longest control-socket path this platform accepts.
 *
 * A UNIX socket address is bounded (104 bytes on macOS, 108 on Linux) and `ssh`
 * binds its listener under a temporary suffix of one dot and fifteen characters,
 * so the configured path has to leave room for both. A data root deep enough to
 * cross that bound sends `ssh` to a path it cannot bind, and every command then
 * fails with a handshake error that names nothing relevant.
 */
const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107
const SOCKET_BIND_SUFFIX = 16

/**
 * A control-socket directory short enough for any data root.
 *
 * Only used when the data root itself is too deep. It is keyed to that root and
 * to the user, and created private, so two installs never share a master.
 */
function shortControlDirectory(storage: MultiplexStorage): string {
  const digest = createHash('sha256').update(storage.resolve('.')).digest('hex').slice(0, 8)
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return join('/tmp', `cio-oven-ssh-${uid}-${digest}`)
}

/** The connection facts that make two Ovens share (or not share) one socket. */
export interface MultiplexIdentity {
  id: string
  host: string
  port: number
  user?: string
  allowClassicalKeyExchange?: boolean
}

/**
 * Multiplexing is an OpenSSH client feature, and Windows OpenSSH omits it. An
 * Oven reached from a Windows client still works, it just opens a connection per
 * command the way every Oven did before this module existed.
 */
export function multiplexSupported(): boolean {
  return process.platform !== 'win32'
}

/**
 * A short, fixed-length control-socket path for one Oven.
 *
 * `ControlPath` is a local UNIX socket and macOS caps its length near 104 bytes,
 * so the identity is hashed to 16 hex characters rather than spelled out. The
 * host and user are part of the key, so editing an Oven's address resolves to a
 * different socket instead of reusing a master to the old host.
 */
export function multiplexControlPath(storage: MultiplexStorage, oven: MultiplexIdentity): string {
  const digest = createHash('sha256')
    .update(
      [
        oven.id,
        oven.host,
        String(oven.port),
        oven.user ?? '',
        oven.allowClassicalKeyExchange ? 'classical-allowed' : 'post-quantum-required-v1'
      ].join('\u0000')
    )
    .digest('hex')
    .slice(0, 16)
  const name = `${digest}.sock`
  const inDataRoot = join(storage.resolve(CONTROL_DIRECTORY), name)
  if (inDataRoot.length + SOCKET_BIND_SUFFIX <= SOCKET_PATH_LIMIT) return inDataRoot
  return join(shortControlDirectory(storage), name)
}

/** The `-o` options that make one invocation join (or become) the shared master. */
export function multiplexOptions(controlPath: string): string[] {
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    `ControlPersist=${IDLE_PERSIST_SECONDS}`
  ]
}

/** Create the private directories the control sockets live in. */
export async function ensureMultiplexDirectory(storage: MultiplexStorage): Promise<void> {
  await mkdir(storage.resolve(CONTROL_DIRECTORY), { recursive: true, mode: 0o700 })
  // Created alongside the data root one, whichever branch the path takes, so a
  // deep root never has to discover its fallback at the moment ssh needs it.
  await mkdir(shortControlDirectory(storage), { recursive: true, mode: 0o700 })
}
