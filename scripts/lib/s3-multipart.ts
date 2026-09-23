/// <reference types="node" />

/**
 * Multipart-upload administration for the release mirror's bucket.
 *
 * Bun's S3 client covers object operations (put, head, list, delete) but not
 * the multipart administration endpoints, and those are the only way to see or
 * remove the parts an interrupted publish leaves behind:
 *
 *   GET    /<bucket>?uploads               list unfinished multipart uploads
 *   DELETE /<bucket>/<key>?uploadId=<id>   abort one of them
 *
 * An unfinished multipart upload is invisible to readers (the key does not
 * exist until the upload completes, so it serves a 404) but it is billed and it
 * shows up as a half-uploaded object in the bucket's dashboard. Every request
 * here is signed with SigV4 by hand for that reason alone.
 *
 * See `scripts/publish-release-mirror.ts`, which aborts the leftovers of an
 * earlier run before it uploads, and docs/DOWNLOAD-MIRROR.md.
 */

import { createHash, createHmac } from 'node:crypto'

/** Credentials and origin needed to sign a request against the bucket. */
export interface S3AdminConfig {
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/** A multipart upload that was started and never completed or aborted. */
export interface InterruptedUpload {
  key: string
  uploadId: string
  /** ISO timestamp of when the upload was started. */
  initiated: string
}

type SignedMethod = 'GET' | 'POST' | 'DELETE'

interface SignedRequest {
  url: string
  headers: Record<string, string>
}

const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex')

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

/** RFC 3986 encoding: the only encoding SigV4 accepts in paths and queries. */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query[name] ?? '')}`)
    .join('&')
}

function signingKey(config: S3AdminConfig, dateStamp: string): Buffer {
  const dateKey = hmacSha256(`AWS4${config.secretAccessKey}`, dateStamp)
  const regionKey = hmacSha256(dateKey, config.region)
  const serviceKey = hmacSha256(regionKey, 's3')
  return hmacSha256(serviceKey, 'aws4_request')
}

/**
 * Sign one S3 request with SigV4. Exported because the release mirror's own
 * verification harness needs to start a multipart upload in order to prove the
 * abort path against a stub, and because the same signer is the only way to
 * reach the administration endpoints.
 */
export function signS3Request(
  config: S3AdminConfig,
  method: SignedMethod,
  options: { key?: string; query?: Readonly<Record<string, string>>; now?: Date } = {}
): SignedRequest {
  const endpoint = config.endpoint.replace(/\/+$/, '')
  const host = new URL(endpoint).host
  const bucketPath = `/${encodeRfc3986(config.bucket)}`
  const path =
    options.key === undefined
      ? bucketPath
      : `${bucketPath}/${options.key.split('/').map(encodeRfc3986).join('/')}`
  const query = canonicalQuery(options.query ?? {})

  const now = options.now ?? new Date()
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const dateStamp = amzDate.slice(0, 8)

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
    'x-amz-date': amzDate
  }
  const headerNames = Object.keys(headers).sort()
  const signedHeaders = headerNames.join(';')
  const canonicalHeaders = headerNames.map((name) => `${name}:${headers[name]}\n`).join('')

  const canonicalRequest = [
    method,
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    EMPTY_PAYLOAD_SHA256
  ].join('\n')
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacSha256(signingKey(config, dateStamp), stringToSign).toString('hex')

  return {
    url: `${endpoint}${path}${query === '' ? '' : `?${query}`}`,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    }
  }
}

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    }
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return XML_ENTITIES[entity] ?? match
  })
}

function tagValue(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)
  return match === null ? null : decodeXml(match[1] ?? '')
}

function parseUploads(body: string): InterruptedUpload[] {
  const uploads: InterruptedUpload[] = []
  for (const match of body.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
    const block = match[1] ?? ''
    const key = tagValue(block, 'Key')
    const uploadId = tagValue(block, 'UploadId')
    if (key === null || uploadId === null) continue
    uploads.push({ key, uploadId, initiated: tagValue(block, 'Initiated') ?? '' })
  }
  return uploads
}

function describeError(body: string): string {
  const code = tagValue(body, 'Code')
  const message = tagValue(body, 'Message')
  const detail = [code, message].filter((part): part is string => part !== null).join(': ')
  return detail === '' ? body.slice(0, 200) : detail
}

/**
 * Every unfinished multipart upload under `prefix`, newest first page order.
 * Throws when the origin refuses the request (a token without
 * `ListBucketMultipartUploads`, an unreachable endpoint).
 */
export async function listInterruptedUploads(
  config: S3AdminConfig,
  prefix = ''
): Promise<InterruptedUpload[]> {
  const uploads: InterruptedUpload[] = []
  let keyMarker: string | undefined
  let uploadIdMarker: string | undefined

  for (;;) {
    const query: Record<string, string> = { uploads: '' }
    if (prefix !== '') query['prefix'] = prefix
    if (keyMarker !== undefined) query['key-marker'] = keyMarker
    if (uploadIdMarker !== undefined) query['upload-id-marker'] = uploadIdMarker

    const request = signS3Request(config, 'GET', { query })
    const response = await fetch(request.url, { headers: request.headers })
    const body = await response.text()
    if (!response.ok) {
      throw new Error(`ListMultipartUploads failed (${response.status}): ${describeError(body)}`)
    }
    uploads.push(...parseUploads(body))

    if (tagValue(body, 'IsTruncated') !== 'true') break
    const nextKey = tagValue(body, 'NextKeyMarker')
    if (nextKey === null || nextKey === '') break
    keyMarker = nextKey
    uploadIdMarker = tagValue(body, 'NextUploadIdMarker') ?? undefined
  }

  return uploads
}

/** Abort one unfinished upload, discarding its parts. */
export async function abortInterruptedUpload(
  config: S3AdminConfig,
  upload: Pick<InterruptedUpload, 'key' | 'uploadId'>
): Promise<void> {
  const request = signS3Request(config, 'DELETE', {
    key: upload.key,
    query: { uploadId: upload.uploadId }
  })
  const response = await fetch(request.url, { method: 'DELETE', headers: request.headers })
  // A 404 means another run aborted it first, which is the outcome we wanted.
  if (!response.ok && response.status !== 404) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `AbortMultipartUpload for ${upload.key} failed (${response.status}): ${describeError(body)}`
    )
  }
}

/**
 * Start a multipart upload and return its id. Only used to prove the abort path
 * (a harness starts one, then checks the sweep removes it), never by a publish.
 */
export async function startMultipartUpload(config: S3AdminConfig, key: string): Promise<string> {
  const request = signS3Request(config, 'POST', { key, query: { uploads: '' } })
  const response = await fetch(request.url, { method: 'POST', headers: request.headers })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`CreateMultipartUpload failed (${response.status}): ${describeError(body)}`)
  }
  const uploadId = tagValue(body, 'UploadId')
  if (uploadId === null || uploadId === '') {
    throw new Error(`CreateMultipartUpload returned no UploadId for ${key}`)
  }
  return uploadId
}
