import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, writeFile, rm, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildProcessEnvironment, resolveExecutablePath } from '../drivers/cli-environment'
import type { OvenRegistry } from './oven-registry'
import { validateIdentityPath } from './oven-validation'

type OvenSshRegistry = Pick<OvenRegistry, 'require'> & {
  storage: Pick<OvenRegistry['storage'], 'resolve'>
  vault: Pick<OvenRegistry['vault'], 'resolve'>
}

export interface OvenSshInvocation {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  dispose: () => Promise<void>
}

/** SSH always invokes a remote shell. Quote each argument at that boundary. */
export function sshQuote(value: string): string {
  if (value.includes('\0')) throw new TypeError('SSH arguments cannot contain null bytes.')
  return `'${value.replace(/'/gu, `'"'"'`)}'`
}

/** Translate bounded stderr into actionable diagnostics without exposing remote secrets. */
function remoteCommandIssue(stderr: string): string {
  if (/npm (?:ERR!|error).*EACCES/iu.test(stderr))
    return 'Permission denied: npm cannot write to its installation prefix or cache. The Oven needs a writable user-owned npm directory.'
  if (
    /sudo:.*(?:password is required|a terminal is required|interactive authentication is required)/iu.test(
      stderr
    )
  )
    return 'sudo: a password is required. Setup needs a password-authenticated Oven connection or passwordless sudo for system package changes.'
  if (/not in the sudoers|not allowed to execute|may not run sudo/iu.test(stderr))
    return 'Permission denied: the Oven user is not allowed to run this command with sudo.'
  if (
    /are you root|must be (?:run as )?root|requires root|superuser privilege|permission denied/iu.test(
      stderr
    )
  )
    return 'Permission denied: system package changes require root or sudo.'
  if (
    /could not get lock|unable to acquire.*lock|another (?:process|instance).*running/iu.test(
      stderr
    )
  )
    return 'Another package operation holds the package-manager lock. Wait for it to finish, then retry.'
  if (/dpkg was interrupted/iu.test(stderr))
    return 'The Oven has an interrupted package configuration. Repair it on the Oven before retrying setup.'
  if (/command not found|is not recognized|No such file or directory/iu.test(stderr))
    return 'A command or file required by this step is missing on the Oven.'
  if (/no space left on device/iu.test(stderr))
    return 'The Oven has insufficient free disk space for this command.'
  if (
    /could not resolve|temporary failure resolving|failed to fetch|could not connect/iu.test(stderr)
  )
    return 'The remote command could not reach its package source. Check the Oven network and repositories.'
  return 'The remote command failed after connecting. Check the package manager or command on the Oven, then retry this step.'
}

export class OvenSsh {
  private tail: Promise<unknown> = Promise.resolve()
  private initialized: Promise<void> | undefined

  constructor(private readonly registry: OvenSshRegistry) {}

  /** Serialize transport work so reconnect/probe cannot flood a low-end device. */
  execute(
    id: string,
    command: string,
    input = '',
    timeoutMs = 30_000,
    onOutput?: (chunk: string) => void,
    forwardAgent = false,
    maxOutputBytes = 2 * 1024 * 1024
  ): Promise<string> {
    if (
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes < 1 ||
      maxOutputBytes > 8 * 1024 * 1024
    )
      throw new TypeError('Invalid Oven response limit.')
    const result = this.tail
      .catch(() => undefined)
      .then(async () => {
        this.initialized ??= this.cleanStaleCredentials()
        await this.initialized
        return this.run(
          id,
          command,
          input,
          timeoutMs,
          undefined,
          onOutput,
          forwardAgent,
          maxOutputBytes
        )
      })
    this.tail = result
    return result
  }

  /** Authenticate sudo through stdin; the elevated command receives no credential input. */
  async executeElevated(
    id: string,
    argv: string[],
    timeoutMs: number,
    authenticate: boolean,
    onOutput?: (chunk: string) => void
  ): Promise<string> {
    const oven = await this.registry.require(id)
    if (!authenticate || oven.connection?.authentication !== 'password' || !oven.passwordRef)
      return this.execute(
        id,
        ['sudo', '-n', ...argv].map(sshQuote).join(' '),
        '',
        timeoutMs,
        onOutput
      )
    const password = await this.registry.vault.resolve(oven.passwordRef)
    if (!password || /[\r\n\0]/u.test(password))
      throw new Error('The Oven login credential cannot authenticate sudo.')
    const command = [
      'sudo',
      '-S',
      '-p',
      '',
      '--',
      'sh',
      '-c',
      'exec "$@" </dev/null',
      'sh',
      ...argv
    ]
      .map(sshQuote)
      .join(' ')
    return this.execute(id, command, `${password}\n`, timeoutMs, onOutput)
  }

  /**
   * Write one secret file on the Oven through the channel's stdin.
   *
   * The value never appears in a command argument, in the remote process list,
   * or in a log line, and the file is created with owner-only permissions in a
   * single atomic move so a partially written key is never readable.
   */
  async putSecretFile(
    id: string,
    path: string,
    contents: string,
    options: { windows?: boolean; timeoutMs?: number } = {}
  ): Promise<void> {
    if (contents.includes('\0')) throw new TypeError('Secret values cannot contain null bytes.')
    if (!/^[A-Za-z0-9._-]{1,120}$/u.test(path)) throw new TypeError('Invalid remote secret path.')
    const command = options.windows
      ? // Create the file with an owner-only ACL, then write through the handle
        // so the plaintext is never visible in a window where it is world-readable.
        [
          `$ErrorActionPreference = 'Stop'`,
          `$dir = Split-Path -Parent ${sshQuote(path)}`,
          `if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }`,
          `$acl = Get-Acl -LiteralPath $dir`,
          `$acl.SetAccessRuleProtection($true, $false)`,
          `$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name`,
          `$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')`,
          `$acl.SetAccessRule($rule)`,
          `Set-Acl -LiteralPath $dir -AclObject $acl`,
          `$content = [Console]::In.ReadToEnd()`,
          `$staged = ${sshQuote(path)} + '.next'`,
          `[System.IO.File]::WriteAllText($staged, $content, (New-Object System.Text.UTF8Encoding($false)))`,
          `Move-Item -LiteralPath $staged -Destination ${sshQuote(path)} -Force`
        ].join('; ')
      : [
          `set -eu`,
          `umask 077`,
          `dir=$(dirname ${sshQuote(path)})`,
          `mkdir -p "$dir"`,
          `chmod 700 "$dir"`,
          `staged=${sshQuote(`${path}.next`)}`,
          `cat > "$staged"`,
          `chmod 600 "$staged"`,
          `mv -f "$staged" ${sshQuote(path)}`
        ].join('; ')
    await this.execute(id, command, contents, options.timeoutMs ?? 30_000)
  }

  /**
   * Write one secret file inside the Oven user's home directory.
   *
   * Used for the dedicated Git identity, which must live at a fixed, well-known
   * location (`~/.ssh/<name>`) that OpenSSH itself resolves. Callers pass a
   * home-relative path and a file name only: no absolute path, no traversal, and
   * no user-controlled directory ever reaches the remote shell. As with
   * `putSecretFile`, the value travels on stdin, never in an argument.
   */
  async putHomeSecretFile(
    id: string,
    relativePath: string,
    contents: string,
    options: { windows?: boolean; timeoutMs?: number } = {}
  ): Promise<void> {
    if (contents.includes('\0')) throw new TypeError('Secret values cannot contain null bytes.')
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(relativePath))
      throw new TypeError('Invalid remote home-relative path.')
    const segments = relativePath.split('/')
    if (segments.some((segment) => segment === '.' || segment === '..'))
      throw new TypeError('Invalid remote home-relative path.')
    const leaf = segments.pop()
    if (!leaf) throw new TypeError('A remote secret path needs a file name.')
    const directory = segments.join('/')
    const stagedSuffix = `.${randomUUID()}.next`
    const command = options.windows
      ? [
          `$ErrorActionPreference = 'Stop'`,
          `$root = Join-Path $env:USERPROFILE ${sshQuote(directory)}`,
          `if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Force -Path $root | Out-Null }`,
          `$acl = Get-Acl -LiteralPath $root`,
          `$acl.SetAccessRuleProtection($true, $false)`,
          `$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name`,
          `$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')`,
          `$acl.SetAccessRule($rule)`,
          `Set-Acl -LiteralPath $root -AclObject $acl`,
          `$content = [Console]::In.ReadToEnd()`,
          `$target = Join-Path $root ${sshQuote(leaf)}`,
          `$staged = $target + ${sshQuote(stagedSuffix)}`,
          `[System.IO.File]::WriteAllText($staged, $content, (New-Object System.Text.UTF8Encoding($false)))`,
          `Move-Item -LiteralPath $staged -Destination $target -Force`
        ].join('; ')
      : [
          `set -eu`,
          `umask 077`,
          `target="$HOME"/${sshQuote(relativePath)}`,
          `dir=$(dirname "$target")`,
          `mkdir -p "$dir"`,
          `chmod 700 "$dir"`,
          `staged="$target"${sshQuote(stagedSuffix)}`,
          `cat > "$staged"`,
          `chmod 600 "$staged"`,
          `mv -f "$staged" "$target"`
        ].join('; ')
    await this.execute(id, command, contents, options.timeoutMs ?? 30_000)
  }

  /**
   * Read one remote file as text. Used only for the Oven's own known_hosts and
   * public keys, never for arbitrary paths supplied by the renderer.
   */
  async readFile(id: string, path: string, timeoutMs = 20_000): Promise<string> {
    if (!/^[A-Za-z0-9._/-]{1,256}$/u.test(path)) throw new TypeError('Invalid remote path.')
    return this.execute(id, `cat ${sshQuote(path)}`, '', timeoutMs)
  }

  /** Bound SSH direct TCP channels. Each channel streams with backpressure. */
  async tunnel(id: string, remotePort: number): Promise<{ port: number; close: () => void }> {
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)
      throw new Error('Choose a valid development-server port.')
    this.initialized ??= this.cleanStaleCredentials()
    await this.initialized
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      if (sockets.size >= 4) {
        socket.destroy()
        return
      }
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      void this.run(id, '', '', 0, { socket, remotePort }).catch(() => socket.destroy())
    })
    server.maxConnections = 4
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The SSH tunnel could not open.')
    return {
      port: address.port,
      close: () => {
        for (const socket of sockets) socket.destroy()
        server.close()
      }
    }
  }

  /** Reclaim private identity files left by a crash without touching a live connection. */
  private async cleanStaleCredentials(): Promise<void> {
    const root = this.registry.storage.resolve('ovens/credentials')
    const entries = await readdir(root, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      }
    )
    for (const entry of entries.slice(0, 100)) {
      if (!entry.isDirectory() || !entry.name.startsWith('connection-')) continue
      const directory = join(root, entry.name)
      const owner = Number(await readFile(join(directory, 'owner'), 'utf8').catch(() => '0'))
      if (Number.isSafeInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0)
          continue
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue
        }
      } else {
        // An interrupted setup has not written a key yet. Leave recent attempts alone.
        const metadata = await stat(directory)
        if (Date.now() - metadata.mtimeMs < 3_600_000) continue
      }
      await rm(directory, { recursive: true, force: true })
    }
  }

  /** Prepare one SSH launch, sharing auth and cleanup with terminals and actions. */
  async prepare(
    id: string,
    command: string | undefined,
    tty = false,
    directPort?: number,
    forwardAgent = false
  ): Promise<OvenSshInvocation> {
    this.initialized ??= this.cleanStaleCredentials()
    await this.initialized
    const oven = await this.registry.require(id)
    const connection = oven.connection
    if (!connection) throw new Error('This Oven has no SSH connection.')
    const env = buildProcessEnvironment()
    const executable = resolveExecutablePath('ssh', env)
    if (!executable) throw new Error('Install OpenSSH on this computer to connect to Ovens.')
    const args = [
      tty ? '-tt' : '-T',
      '-p',
      String(connection.port),
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=2',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `ForwardAgent=${forwardAgent ? 'yes' : 'no'}`,
      '-o',
      `PasswordAuthentication=${connection.authentication === 'password' ? 'yes' : 'no'}`,
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'ClearAllForwardings=yes'
    ]
    if (connection.user) args.push('-l', connection.user)
    let scratch: string | undefined
    const configureAskpass = async (directory: string, reference: string): Promise<void> => {
      if (process.platform === 'win32')
        throw new Error(
          'Password and encrypted-key connections require an SSH askpass helper on Windows. Use SSH agent authentication on this device.'
        )
      const helper = join(directory, 'askpass')
      await writeFile(helper, '#!/bin/sh\nprintf \'%s\\n\' "$CIO_OVEN_KEY_PASSPHRASE"\n', {
        mode: 0o700,
        flag: 'wx'
      })
      env['SSH_ASKPASS'] = helper
      env['SSH_ASKPASS_REQUIRE'] = 'force'
      env['DISPLAY'] ??= ':0'
      env['CIO_OVEN_KEY_PASSPHRASE'] = await this.registry.vault.resolve(reference)
    }
    try {
      if (connection.authentication === 'password') {
        if (!oven.passwordRef) throw new Error('Save the SSH account password for this Oven.')
        const scratchRoot = this.registry.storage.resolve('ovens/credentials')
        await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
        scratch = await mkdtemp(join(scratchRoot, 'connection-'))
        await writeFile(join(scratch, 'owner'), String(process.pid), { mode: 0o600, flag: 'wx' })
        await configureAskpass(scratch, oven.passwordRef)
        args.push(
          '-o',
          'PreferredAuthentications=password',
          '-o',
          'PubkeyAuthentication=no',
          '-o',
          'NumberOfPasswordPrompts=1'
        )
      }
      if (connection.authentication === 'identity') {
        if (!connection.identityFile) throw new Error('Select an SSH identity file.')
        args.push(
          '-i',
          await validateIdentityPath(connection.identityFile),
          '-o',
          'IdentitiesOnly=yes'
        )
      }
      if (connection.authentication === 'vault') {
        if (!oven.privateKeyRef) throw new Error('This Oven has no vaulted private key.')
        const scratchRoot = this.registry.storage.resolve('ovens/credentials')
        await mkdir(scratchRoot, { recursive: true, mode: 0o700 })
        scratch = await mkdtemp(join(scratchRoot, 'connection-'))
        await writeFile(join(scratch, 'owner'), String(process.pid), { mode: 0o600, flag: 'wx' })
        const keyPath = join(scratch, 'identity')
        await writeFile(keyPath, await this.registry.vault.resolve(oven.privateKeyRef), {
          mode: 0o600,
          flag: 'wx'
        })
        args.push('-i', keyPath, '-o', 'IdentitiesOnly=yes')
        if (oven.passphraseRef) {
          await configureAskpass(scratch, oven.passphraseRef)
        }
      }
      if (directPort !== undefined) args.push('-W', `127.0.0.1:${directPort}`)
      args.push(
        '-o',
        `BatchMode=${env['SSH_ASKPASS'] ? 'no' : 'yes'}`,
        '--',
        connection.host,
        ...(command === undefined ? [] : [command])
      )
      return {
        executable,
        args,
        env,
        dispose: async () => {
          delete env['CIO_OVEN_KEY_PASSPHRASE']
          if (scratch) await rm(scratch, { recursive: true, force: true })
        }
      }
    } catch (error) {
      delete env['CIO_OVEN_KEY_PASSPHRASE']
      if (scratch) await rm(scratch, { recursive: true, force: true })
      throw error
    }
  }

  private async run(
    id: string,
    command: string,
    input: string,
    timeoutMs: number,
    channel?: { socket: Socket; remotePort: number },
    onOutput?: (chunk: string) => void,
    forwardAgent = false,
    maxOutputBytes = 2 * 1024 * 1024
  ): Promise<string> {
    if (channel?.socket.destroyed) throw new Error('The preview connection closed.')
    const prepared = await this.prepare(
      id,
      channel ? undefined : command,
      false,
      channel?.remotePort,
      forwardAgent
    )
    const { executable, args, env } = prepared
    try {
      if (channel?.socket.destroyed) throw new Error('The preview connection closed.')
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(executable, args, {
          env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        let output = ''
        let remoteStderr = ''
        let bytes = 0
        let failure: Error | undefined
        let timedOut = false
        let sshIssue = 'Check authentication and trust this host with OpenSSH before reconnecting.'
        const timer =
          timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true
                child.kill('SIGKILL')
              }, timeoutMs)
            : undefined
        const capture = (chunk: Buffer): void => {
          bytes += chunk.length
          if (bytes > maxOutputBytes) {
            failure = new Error(
              `The Oven response exceeded the ${maxOutputBytes / 1024 / 1024} MiB limit.`
            )
            child.kill('SIGKILL')
            return
          }
          const text = chunk.toString('utf8')
          output += text
          onOutput?.(text)
        }
        if (channel) {
          channel.socket.pipe(child.stdin)
          child.stdout.pipe(channel.socket)
          channel.socket.once('close', () => child.kill('SIGTERM'))
          channel.socket.once('error', () => child.kill('SIGTERM'))
        } else child.stdout.on('data', capture)
        // Recognize failures without echoing server/config stderr or credential paths.
        child.stderr.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          remoteStderr = (remoteStderr + text).slice(-8192)
          onOutput?.(text)
          if (/REMOTE HOST IDENTIFICATION HAS CHANGED/u.test(text)) {
            sshIssue =
              'The host key changed. Verify the host identity before updating OpenSSH trust.'
          } else if (/Host key verification failed/u.test(text)) {
            sshIssue =
              'This host is not trusted by OpenSSH. Verify its fingerprint and connect with OpenSSH first.'
          } else if (/Permission denied/u.test(text)) {
            sshIssue = args.includes('PreferredAuthentications=password')
              ? 'The host rejected password login. Check the SSH username and saved password, and that this server allows password authentication.'
              : 'The host rejected the SSH credential. Check the SSH username and that the matching public key is in that user’s authorized_keys on the Oven. For SSH agent authentication, load the private key into your agent or select its identity file.'
          } else if (/Connection refused/u.test(text)) {
            sshIssue =
              'The host refused the connection. Check that SSH is running on the selected port.'
          } else if (/No route to host|Network is unreachable/u.test(text)) {
            sshIssue = 'This host is unreachable from this computer.'
          } else if (/Could not resolve hostname/u.test(text)) {
            sshIssue = 'The SSH hostname or config alias could not be resolved.'
          } else if (/Operation timed out|Connection timed out/u.test(text)) {
            sshIssue = 'The SSH connection timed out.'
          } else if (/Node.js is required/u.test(text)) {
            sshIssue = 'Install Node.js 22 or later on this Oven before setting up its service.'
          }
        })
        child.on('error', (error) => {
          failure = error
        })
        child.stdin.on('error', () => undefined)
        child.on('close', (code) => {
          clearTimeout(timer)
          delete env['CIO_OVEN_KEY_PASSPHRASE']
          if (failure) reject(failure)
          else if (timedOut)
            reject(new Error('The Oven did not respond before the connection timeout.'))
          else if (code === 255 || code === null)
            reject(new Error(`SSH connection failed (${code ?? 'disconnected'}). ${sshIssue}`))
          else if (code !== 0)
            reject(
              new Error(`Remote command failed (${code}). ${remoteCommandIssue(remoteStderr)}`)
            )
          else resolve(output)
        })
        if (!channel) child.stdin.end(input)
      })
    } finally {
      await prepared.dispose()
    }
  }
}
