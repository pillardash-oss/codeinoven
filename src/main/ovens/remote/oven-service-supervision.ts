/**
 * Keeping the Oven service alive on a POSIX Oven across a reboot.
 *
 * A detached process is enough to survive the SSH session that started it, and
 * that is all this used to do - which is exactly why an Oven went missing after
 * a restart: nothing owned the process, and nothing started it again. A real
 * supervisor fixes both at once, and every POSIX Oven already runs one:
 *
 * - Termux on Android supervises its packages with runit. A service there is a
 *   directory with a `run` script, restarted by `runsv` the moment it exits, and
 *   `~/.termux/boot/*.sh` is what Termux's boot receiver runs to bring that
 *   supervision back after the device restarts.
 * - A Linux Oven with a systemd user manager gets a user unit with
 *   `Restart=always`, enabled so it starts without anyone logging in.
 *
 * Anything else keeps the detached spawn: a supervisor we cannot verify is worse
 * than an honest process we can start again.
 *
 * This module is deliberately free of Electron imports: the published `cio-oven`
 * CLI and the remote service entry both bundle it, and neither has an app.
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Where a Termux Oven keeps its supervisor's service definitions. */
export const TERMUX_SERVICE_DIRECTORY = 'var/service'
/** The runit service this module owns on a Termux Oven. */
export const TERMUX_SERVICE_NAME = 'cio-oven'
/** The Termux boot script that restores supervision after a restart. */
export const TERMUX_BOOT_SCRIPT = '00-cio-oven.sh'
/** The unit name used for the systemd user service on a Linux Oven. */
export const SYSTEMD_UNIT_NAME = 'cio-oven.service'

/** Everything a supervision script needs, resolved by the caller. */
export interface OvenSupervisionInput {
  /** Absolute path to the Node binary running the Oven. */
  nodePath: string
  /** Absolute path to the deployed `service.mjs`. */
  servicePath: string
  /** Data root the daemon reads and writes. */
  dataRoot: string
  /** Service revision to report, so the app can match its own build. */
  revision?: string
  /** The Oven account's home directory. */
  home: string
  /** Termux's `$PREFIX`, when this Oven runs inside Termux. */
  prefix?: string
}

/** Quote a value as a single POSIX shell word, whatever it contains. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** Quote a value for a systemd unit file, where backslashes and quotes escape. */
function systemdQuote(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/%/gu, '%%')}"`
}

/**
 * Whether this Oven runs inside Termux.
 *
 * Termux reports `linux` for `process.platform` because that is what it is, so
 * the prefix is the only honest signal. It points inside the app's private
 * directory, which no ordinary Linux Oven has.
 */
export function isTermuxPrefix(prefix: string | undefined): boolean {
  if (!prefix) return false
  return prefix.includes('/com.termux/') || /\/com\.termux$/u.test(prefix)
}

/** The runit service directory for this Termux prefix. */
export function termuxServiceDirectory(prefix: string): string {
  return join(prefix, TERMUX_SERVICE_DIRECTORY, TERMUX_SERVICE_NAME)
}

/**
 * The script `runsv` starts.
 *
 * `exec` is what makes the supervisor own the daemon itself rather than a shell
 * that holds it, so a stop reaches node and a crash is seen immediately.
 */
export function termuxServiceScript(input: OvenSupervisionInput): string {
  const lines = [
    '#!/data/data/com.termux/files/usr/bin/sh',
    '# CodeInOven Oven service. Supervised by runsv and started at boot; do not edit.',
    `export CODEINOVEN_OVEN_DATA_ROOT=${shellQuote(input.dataRoot)}`
  ]
  if (input.revision) lines.push(`export CODEINOVEN_OVEN_REVISION=${shellQuote(input.revision)}`)
  lines.push(`exec ${shellQuote(input.nodePath)} ${shellQuote(input.servicePath)} daemon`)
  return `${lines.join('\n')}\n`
}

/** The `svlogd` script that keeps the daemon's output for the next diagnosis. */
export function termuxLogScript(input: OvenSupervisionInput): string {
  const prefix = input.prefix ?? '/data/data/com.termux/files/usr'
  return [
    '#!/data/data/com.termux/files/usr/bin/sh',
    `exec ${shellQuote(join(prefix, 'bin', 'svlogd'))} -tt ${shellQuote(join(prefix, 'var', 'log', 'cio-oven'))}`,
    ''
  ].join('\n')
}

/**
 * The script Termux's boot receiver runs after a restart.
 *
 * It is deliberately dull and repeatable: restart the supervisor if it is not
 * running, then make sure this Oven's SSH server and the Oven itself are up.
 * A second run changes nothing, which matters because a device can deliver the
 * boot broadcast more than once.
 */
export function termuxBootScript(input: OvenSupervisionInput): string {
  const prefix = input.prefix ?? '/data/data/com.termux/files/usr'
  const bin = join(prefix, 'bin')
  const startServices = join(prefix, 'etc', 'profile.d', 'start-services.sh')
  return [
    '#!/data/data/com.termux/files/usr/bin/sh',
    '# Runs at boot through Termux\u2019s boot receiver: restore the service supervisor,',
    '# then bring up this Oven\u2019s SSH server and the Oven itself. Safe to repeat.',
    `PREFIX=${shellQuote(prefix)}`,
    'export PREFIX',
    `export SVDIR=${shellQuote(join(prefix, TERMUX_SERVICE_DIRECTORY))}`,
    `export LOGDIR=${shellQuote(join(prefix, 'var', 'log'))}`,
    `command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock`,
    `if [ -r ${shellQuote(startServices)} ]; then . ${shellQuote(startServices)}; fi`,
    // Termux's starter backgrounds the supervisor, so waiting is the only way to
    // know whether it actually came up.
    'n=0',
    `while [ "$n" -lt 20 ]; do`,
    `  ${shellQuote(join(bin, 'pgrep'))} -f runsvdir >/dev/null 2>&1 && break`,
    '  sleep 0.5',
    '  n=$((n + 1))',
    'done',
    // A boot where Termux's own starter is missing or never got going would
    // otherwise leave the device with no supervisor and no way in at all.
    `if ! ${shellQuote(join(bin, 'pgrep'))} -f runsvdir >/dev/null 2>&1; then`,
    `  ${shellQuote(join(bin, 'runsvdir'))} "$SVDIR" >/dev/null 2>&1 &`,
    'fi',
    'n=0',
    `while [ "$n" -lt 20 ]; do`,
    `  ${shellQuote(join(bin, 'pgrep'))} -f runsvdir >/dev/null 2>&1 && break`,
    '  sleep 0.5',
    '  n=$((n + 1))',
    'done',
    // sshd is the way in: without it the app cannot even ask the Oven anything.
    `${shellQuote(join(bin, 'sv'))} up sshd`,
    `${shellQuote(join(bin, 'sv'))} up ${TERMUX_SERVICE_NAME}`,
    ''
  ].join('\n')
}

/**
 * The systemd user unit for a Linux Oven.
 *
 * `Restart=always` is the reason this exists: the daemon exits when it is asked
 * to shut down for an update, and it must come back without the app holding it.
 * The environment lines carry the same data root and revision the direct spawn
 * passed, so the Oven reports exactly the build the app installed.
 */
export function systemdUnitFile(input: OvenSupervisionInput): string {
  const environment = [`Environment=${systemdQuote(`CODEINOVEN_OVEN_DATA_ROOT=${input.dataRoot}`)}`]
  if (input.revision)
    environment.push(`Environment=${systemdQuote(`CODEINOVEN_OVEN_REVISION=${input.revision}`)}`)
  return [
    '[Unit]',
    'Description=CodeInOven Oven service',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    'Restart=always',
    'RestartSec=2',
    ...environment,
    `ExecStart=${systemdQuote(input.nodePath)} ${systemdQuote(input.servicePath)} daemon`,
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n')
}

/** Where a Linux Oven's unit file lives, relative to its home. */
export function systemdUnitDirectory(home: string): string {
  return join(home, '.config', 'systemd', 'user')
}

/** Write a file and hand it the mode a supervisor expects. */
async function writeExecutableFile(path: string, contents: string, mode: number): Promise<void> {
  await writeFile(path, contents, { mode })
  // `writeFile` only applies the mode when it creates the file, so an existing
  // script that predates a permission fix keeps its old bits without this.
  await chmod(path, mode)
}

/** Read an existing file, treating "not there yet" as empty content. */
async function readOrEmpty(path: string): Promise<string> {
  return await readFile(path, 'utf8').catch(() => '')
}

/**
 * Install Termux supervision and start it.
 *
 * Returns the directory layout it created so a caller can report what happened.
 * A `run` script is left alone when it already starts this exact service from
 * this exact Node binary: the app must never fight a user's own edit.
 */
export async function installTermuxSupervision(input: OvenSupervisionInput): Promise<{
  serviceDirectory: string
  bootScript: string
}> {
  const prefix = input.prefix ?? '/data/data/com.termux/files/usr'
  const serviceDirectory = termuxServiceDirectory(prefix)
  const bootScript = join(input.home, '.termux', 'boot', TERMUX_BOOT_SCRIPT)
  await mkdir(join(serviceDirectory, 'log'), { recursive: true })
  await mkdir(join(prefix, 'var', 'log', 'cio-oven'), { recursive: true })
  await mkdir(join(input.home, '.termux', 'boot'), { recursive: true })
  const runScript = join(serviceDirectory, 'run')
  const expected = termuxServiceScript(input)
  if ((await readOrEmpty(runScript)) !== expected)
    await writeExecutableFile(runScript, expected, 0o700)
  const logScript = join(serviceDirectory, 'log', 'run')
  const expectedLog = termuxLogScript(input)
  if ((await readOrEmpty(logScript)) !== expectedLog)
    await writeExecutableFile(logScript, expectedLog, 0o700)
  await writeExecutableFile(bootScript, termuxBootScript(input), 0o700)
  return { serviceDirectory, bootScript }
}

/** Install the systemd user unit for a Linux Oven. */
export async function installSystemdUnit(input: OvenSupervisionInput): Promise<string> {
  const directory = systemdUnitDirectory(input.home)
  await mkdir(directory, { recursive: true })
  const unit = join(directory, SYSTEMD_UNIT_NAME)
  await writeFile(unit, systemdUnitFile(input), { mode: 0o600 })
  return unit
}

/** Ask a supervisor to bring the Oven service up, tolerating an absent one. */
export type SupervisionCommandRunner = (
  program: string,
  args: readonly string[],
  environment?: NodeJS.ProcessEnv
) => Promise<boolean>

/** Bring the Oven service up under Termux's runit, starting the supervisor first. */
export async function startTermuxSupervision(
  input: OvenSupervisionInput,
  run: SupervisionCommandRunner
): Promise<boolean> {
  const prefix = input.prefix ?? '/data/data/com.termux/files/usr'
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PREFIX: prefix,
    SVDIR: join(prefix, TERMUX_SERVICE_DIRECTORY),
    LOGDIR: join(prefix, 'var', 'log')
  }
  const sv = join(prefix, 'bin', 'sv')
  // The SSH server is the way in, so it is brought up with the same call: an
  // Oven that answers only while someone holds a terminal open is not reachable.
  await rm(join(prefix, TERMUX_SERVICE_DIRECTORY, 'sshd', 'down'), { force: true })
  if (!(await run(sv, ['up', TERMUX_SERVICE_NAME], environment))) {
    // No supervisor yet: Termux starts it from its own script, then tries again.
    await run(join(prefix, 'bin', 'service-daemon'), ['start'], environment)
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      if (await run(sv, ['up', TERMUX_SERVICE_NAME], environment)) break
    }
  }
  await run(sv, ['up', 'sshd'], environment)
  // A service left "down" by an earlier install still has to be restarted once
  // the new script is in place, or it keeps running the bundle it started with.
  await run(sv, ['restart', TERMUX_SERVICE_NAME], environment)
  return await run(sv, ['status', TERMUX_SERVICE_NAME], environment)
}

/** Enable and start the systemd user unit, without ever leaving it disabled. */
export async function startSystemdSupervision(
  input: OvenSupervisionInput,
  run: SupervisionCommandRunner
): Promise<boolean> {
  await installSystemdUnit(input)
  const enabled = await run('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME])
  if (!enabled) return false
  // Without lingering the user manager stops with the login session, which is
  // the same missing-service problem this module exists to end. Either outcome
  // is acceptable: a machine that refuses lingering still has a running unit.
  await run('loginctl', ['enable-linger'])
  return true
}

/** The POSIX environment this Oven runs in, resolved once. */
export interface OvenSupervisionTarget {
  termux: boolean
  systemd: boolean
}

/**
 * What this machine can supervise with.
 *
 * Detection is separate from installation so the caller can decide to fall back
 * before it writes anything, and so the decision is testable without a machine.
 */
export function supervisionTarget(input: {
  platform: NodeJS.Platform
  prefix: string | undefined
  systemdUserManager: boolean
}): OvenSupervisionTarget {
  if (input.platform === 'win32') return { termux: false, systemd: false }
  if (input.platform === 'android' || isTermuxPrefix(input.prefix))
    return { termux: true, systemd: false }
  return { termux: false, systemd: input.systemdUserManager }
}
