import type { OvenPreflightReport } from '../../lib/ovens'
import { sshQuote, type OvenSsh } from './oven-ssh'
import type { SecretVault } from '../storage/secret-vault'
import { Logger } from '../system/logger'

/** Dedicated identity file name on the Oven. Never the machine login key. */
const IDENTITY_FILE = 'codeinoven-github'
/** Home-relative location of the dedicated identity, resolved by OpenSSH itself. */
const IDENTITY_RELATIVE = `.ssh/${IDENTITY_FILE}`
const GITHUB_SSH = 'git@github.com'

/**
 * GitHub's published host keys, fetched from https://api.github.com/meta.
 * They are shown to the user so an unknown or changed host key can be judged
 * against a source GitHub itself publishes. CodeInOven never runs `ssh-keyscan`
 * to accept a key on the user's behalf, and never disables strict checking.
 */
export const GITHUB_HOST_KEY_FINGERPRINTS: readonly string[] = [
  'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU',
  'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM',
  'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s'
]

export type OvenGitVerificationStatus =
  | 'verified'
  | 'not-configured'
  | 'git-missing'
  | 'key-missing'
  | 'key-rejected'
  | 'host-key-untrusted'
  | 'host-key-changed'
  | 'passphrase-required'
  | 'unreachable'

export interface OvenGitVerification {
  status: OvenGitVerificationStatus
  message: string
  /** The public key to register on GitHub, when it could be derived. */
  publicKey?: string
  expectedHostKeyFingerprints: readonly string[]
}

export interface OvenGitIdentityPorts {
  ssh: OvenSsh
  vault: SecretVault
}

/**
 * A dedicated GitHub SSH identity for one Oven.
 *
 * The key is separate from the credential used to log in, so revoking the Oven
 * never revokes the user's machine access. Nothing here reaches a command
 * argument or a log line: the key travels on the SSH channel's stdin, is stored
 * through the encrypted vault, and every Git call passes it explicitly with
 * `IdentitiesOnly=yes` so the Oven's agent and login keys are never offered.
 */
export class OvenGitIdentityService {
  constructor(private readonly ports: OvenGitIdentityPorts) {}

  private windows(report: OvenPreflightReport): boolean {
    return report.platform === 'win32'
  }

  /**
   * Install the dedicated key on the Oven and derive its public half. Existing
   * `~/.ssh/config`, `authorized_keys`, and the login identity are never read
   * or modified: every Git operation names this file explicitly instead.
   */
  async configure(
    ovenId: string,
    configuration: { privateKeyRef?: string; passphraseRef?: string; publicKey?: string },
    report: OvenPreflightReport
  ): Promise<string[]> {
    const issues: string[] = []
    let publicKey = configuration.publicKey
    if (configuration.privateKeyRef) {
      const privateKey = await this.ports.vault.resolve(configuration.privateKeyRef)
      if (!/^-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----\r?\n/u.test(privateKey))
        throw new Error('The stored Git identity is not a readable private key.')
      await this.ports.ssh.putHomeSecretFile(ovenId, IDENTITY_RELATIVE, privateKey, {
        windows: this.windows(report)
      })
      Logger.dev('Wrote the dedicated Git identity to the oven', {
        ovenId,
        windows: this.windows(report),
        bytes: Buffer.byteLength(privateKey)
      })
    }
    if (!publicKey) publicKey = await this.derivePublicKey(ovenId, this.identityPath(report), report)
    if (!publicKey) {
      issues.push(
        'The Oven could not read the public half of the dedicated key. Add the public key to GitHub manually.'
      )
    }
    const verification = await this.verify(ovenId, report)
    if (verification.status !== 'verified') issues.push(verification.message)
    return issues
  }

  /**
   * Ask GitHub whether the dedicated key is authorized, with strict host-key
   * checking and no agent forwarding. Every distinct failure is named, because
   * "Git is not working" is useless when the causes need different fixes.
   */
  async verify(ovenId: string, report: OvenPreflightReport): Promise<OvenGitVerification> {
    if (!report.git.installed)
      return {
        status: 'git-missing',
        message: 'Git is not installed on the Oven, so its SSH identity cannot be verified.',
        expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
      }
    const present = await this.ports.ssh
      .execute(
        ovenId,
        this.windows(report)
          ? `powershell -NoProfile -NonInteractive -Command "if (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.ssh\\${IDENTITY_FILE}')) { 'present' } else { 'absent' }"`
          : `test -f ~/.ssh/${IDENTITY_FILE} && printf present || printf absent`,
        '',
        20_000
      )
      .catch(() => '')
    if (!present.includes('present'))
      return {
        status: 'key-missing',
        message: 'The dedicated Git identity is not on this Oven yet.',
        expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
      }

    const sshOptions = [
      'BatchMode=yes',
      'IdentitiesOnly=yes',
      'StrictHostKeyChecking=yes',
      'ForwardAgent=no',
      'ConnectTimeout=15'
    ].join(' ')
    const probe = this.windows(report)
      ? [
          `$identity = Join-Path $env:USERPROFILE '.ssh\\${IDENTITY_FILE}'`,
           `$env:GIT_SSH_COMMAND = 'ssh -i "' + $identity + '" ${sshOptions}'`,
          `& ssh -T -i "$identity" ${sshOptions} ${GITHUB_SSH} 2>&1 | Out-String`
        ].join('; ')
      : `GIT_SSH_COMMAND="ssh -i ~/.ssh/${IDENTITY_FILE} ${sshOptions}" ssh -T ${sshQuote(GITHUB_SSH)} 2>&1; printf '\\nexit=%s\\n' "$?"`

    let output = ''
    try {
      output = await this.ports.ssh.execute(ovenId, probe, '', 45_000)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/REMOTE HOST IDENTIFICATION HAS CHANGED/u.test(message))
        return {
          status: 'host-key-changed',
          message:
            'The host key for github.com changed on this Oven. Verify the new key against GitHub’s published fingerprints before trusting it.',
          expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
        }
      return {
        status: 'unreachable',
        message: message || 'The Oven could not reach github.com over SSH.',
        expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
      }
    }

    if (/Host key verification failed/u.test(output) || /not known to hosts/u.test(output))
      return {
        status: 'host-key-untrusted',
        message: `This Oven does not trust github.com yet. Compare its key with GitHub’s published fingerprints, then add github.com to its known_hosts.`,
        expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
      }
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED/u.test(output))
      return {
        status: 'host-key-changed',
        message:
          'The host key for github.com changed on this Oven. Verify the new key against GitHub’s published fingerprints before trusting it.',
        expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
      }
    if (/Could not resolve hostname|Connection refused|timed out|No route to host/u.test(output))
      return {
        status: 'unreachable',
        message: 'The Oven cannot reach github.com over SSH. Check its network and any firewall.',
        expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
      }
    if (/Enter passphrase|passphrase|Unlock/i.test(output))
      return {
        status: 'passphrase-required',
        message:
          'The dedicated key is passphrase-protected and the Oven has no agent holding it unlocked. Load it into the Oven’s ssh-agent or use an unprotected dedicated key.',
        expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
      }
    if (/Permission denied/u.test(output)) {
      const publicKey = await this.derivePublicKey(ovenId, this.identityPath(report), report)
      return {
        status: 'key-rejected',
        message:
          'GitHub did not accept this key. Add its public half to the GitHub account as a new SSH key, then verify again.',
        ...(publicKey ? { publicKey } : {}),
        expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
      }
    }
    /* GitHub answers ssh -T with exit code 1 and a success banner. */
    if (/successfully authenticated/i.test(output))
      return {
        status: 'verified',
        message: 'GitHub accepted the dedicated SSH key on this Oven.',
        expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
      }
    return {
      status: 'unreachable',
      message: 'GitHub did not answer the SSH verification on this Oven.',
      expectedHostKeyFingerprints: GITHUB_HOST_KEY_FINGERPRINTS
    }
  }

  /** Read the public half from the installed private key, when the Oven can. */
  private async derivePublicKey(
    ovenId: string,
    path: string,
    report: OvenPreflightReport
  ): Promise<string | undefined> {
    const command =
      report.platform === 'win32'
      ? `powershell -NoProfile -NonInteractive -Command "& ssh-keygen -y -f ${sshQuote(windowsIdentity(path))} 2>$null"`
      : `ssh-keygen -y -f ${sshQuote(path)} 2>/dev/null`
    try {
      const output = await this.ports.ssh.execute(ovenId, command, '', 20_000)
      const line = output.split(/\r?\n/u).find((entry) => entry.startsWith('ssh-') || entry.startsWith('ecdsa-'))
      return line?.trim() || undefined
    } catch {
      return undefined
    }
  }

  /** The absolute path the Oven resolves for the dedicated identity. */
  private identityPath(report: OvenPreflightReport): string {
    return report.platform === 'win32' ? `%USERPROFILE%\\${IDENTITY_RELATIVE.replace('/', '\\')}` : `~/${IDENTITY_RELATIVE}`
  }
}

function windowsIdentity(path: string): string {
  return path.replace(/%USERPROFILE%/gu, '"$env:USERPROFILE"').replace(/\\/gu, '\\')
}
