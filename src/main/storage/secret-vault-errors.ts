import type { VaultWriterIdentity } from './secret-vault-writer'

/** The OS keyring is unavailable, so no secret may be read or written. */
export class VaultUnavailableError extends Error {
  constructor() {
    super('Secure credential storage is unavailable on this device')
    this.name = 'VaultUnavailableError'
  }
}

/** Nothing is stored under that ref. */
export class VaultRecordMissingError extends Error {
  constructor(readonly ref: string) {
    super('Credential not found')
    this.name = 'VaultRecordMissingError'
  }
}

/**
 * A record exists but this launch's OS keyring key cannot decrypt it.
 *
 * Two situations produce this, and the message names which one applies:
 *
 * - Another build wrote the record. `safeStorage`'s key lives in the keyring
 *   under a service derived from the app name (`<app name> Safe Storage`), so a
 *   launch that reports a different name holds a different key and can never read
 *   it. Every launch that shares one config root therefore has to report one name.
 * - The keyring key was replaced under a record this build wrote itself (the item
 *   was recreated, or the confidential-data prompt was denied). Nothing can
 *   recover the old ciphertext.
 *
 * Either way the credential is unusable until it is stored again, which is why
 * the report says so instead of leaving a bare keyring error in the log.
 */
export class VaultCiphertextUnreadableError extends Error {
  constructor(
    readonly ref: string,
    readonly writer: VaultWriterIdentity | null,
    readonly currentWriter: VaultWriterIdentity | null,
    cause: unknown
  ) {
    super(describeUnreadableRecord(ref, writer, currentWriter), { cause })
    this.name = 'VaultCiphertextUnreadableError'
  }
}

function describeUnreadableRecord(
  ref: string,
  writer: VaultWriterIdentity | null,
  current: VaultWriterIdentity | null
): string {
  const currentName = current
    ? `${current.app} ${current.version} (${current.build} build)`
    : 'this launch'
  if (writer && (writer.app !== current?.app || writer.build !== current?.build)) {
    return `Credential "${ref}" was written by ${writer.app} ${writer.version} (${writer.build} build) on ${writer.platform} and cannot be decrypted by ${currentName}: the OS keyring key is derived from the app name, so a build that reports a different name holds a different key. Store the credential again from this build.`
  }
  const author = writer
    ? ` It was written by ${writer.app} ${writer.version} (${writer.build} build).`
    : ' It carries no author, so it predates writer identity.'
  return `Credential "${ref}" exists but ${currentName} cannot decrypt it with this device's OS keyring key.${author} The keyring key was replaced, or another build wrote the record. Store the credential again to repair it.`
}
