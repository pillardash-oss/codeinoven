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

export class OvenSsh {
  private tail: Promise<unknown> = Promise.resolve()
  private initialized: Promise<void> | undefined

  constructor(private readonly registry: OvenSshRegistry) {}

  /** Serialize transport work so reconnect/probe cannot flood a low-end device. */
  execute(id: string, command: string, input = '', timeoutMs = 30_000): Promise<string> {
    const result = this.tail
      .catch(() => undefined)
      .then(async () => {
        this.initialized ??= this.cleanStaleCredentials()
        await this.initialized
        return this.run(id, command, input, timeoutMs)
      })
    this.tail = result
    return result
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
    directPort?: number
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
      'ForwardAgent=no',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'ClearAllForwardings=yes'
    ]
    if (connection.user) args.push('-l', connection.user)
    let scratch: string | undefined
    try {
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
          // The helper contains no credential. SSH obtains it from this child's environment.
          if (process.platform === 'win32')
            throw new Error('Use SSH agent for passphrase-protected keys on Windows.')
          const helper = join(scratch, 'askpass')
          await writeFile(helper, '#!/bin/sh\nprintf \'%s\\n\' "$CIO_OVEN_KEY_PASSPHRASE"\n', {
            mode: 0o700,
            flag: 'wx'
          })
          env['SSH_ASKPASS'] = helper
          env['SSH_ASKPASS_REQUIRE'] = 'force'
          env['DISPLAY'] ??= ':0'
          env['CIO_OVEN_KEY_PASSPHRASE'] = await this.registry.vault.resolve(oven.passphraseRef)
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
    channel?: { socket: Socket; remotePort: number }
  ): Promise<string> {
    if (channel?.socket.destroyed) throw new Error('The preview connection closed.')
    const prepared = await this.prepare(
      id,
      channel ? undefined : command,
      false,
      channel?.remotePort
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
          if (bytes > 2 * 1024 * 1024) {
            failure = new Error('The Oven response exceeded the 2 MiB limit.')
            child.kill('SIGKILL')
            return
          }
          output += chunk.toString('utf8')
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
          if (/REMOTE HOST IDENTIFICATION HAS CHANGED/u.test(text)) {
            sshIssue =
              'The host key changed. Verify the host identity before updating OpenSSH trust.'
          } else if (/Host key verification failed/u.test(text)) {
            sshIssue =
              'This host is not trusted by OpenSSH. Verify its fingerprint and connect with OpenSSH first.'
          } else if (/Permission denied/u.test(text)) {
            sshIssue =
              'The host rejected the SSH credential. Check the SSH username and that the matching public key is in that user’s authorized_keys on the Oven. For SSH agent authentication, load the private key into your agent or select its identity file.'
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
          else if (code !== 0)
            reject(new Error(`SSH connection failed (${code ?? 'disconnected'}). ${sshIssue}`))
          else resolve(output)
        })
        if (!channel) child.stdin.end(input)
      })
    } finally {
      await prepared.dispose()
    }
  }
}
