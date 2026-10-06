import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import type { OvenSsh } from './oven-ssh'

const execute = promisify(execFile)
const synchronized = new WeakMap<OvenSsh, Map<string, string>>()

/** Share only GitHub public host keys that OpenSSH already trusts locally. */
export async function syncLocalGitHostTrust(ssh: OvenSsh, ovenId: string): Promise<void> {
  const result = await execute('ssh-keygen', ['-F', 'github.com'], {
    timeout: 5_000,
    maxBuffer: 32 * 1024
  }).catch(() => null)
  const keys = result?.stdout
    .split(/\r?\n/u)
    .filter(
      (line) =>
        !line.startsWith('#') &&
        /^\S+ (?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+=*(?: .*)?$/u.test(line)
    )
    .join('\n')
  if (!keys) return
  const hash = createHash('sha256').update(keys).digest('hex')
  const cache = synchronized.get(ssh) ?? new Map<string, string>()
  if (cache.get(ovenId) === hash) return
  await ssh.putHomeSecretFile(ovenId, '.ssh/codeinoven-local-github-known-hosts', `${keys}\n`)
  cache.set(ovenId, hash)
  synchronized.set(ssh, cache)
}
