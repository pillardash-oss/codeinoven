#!/usr/bin/env bun
/**
 * Publish the built MSIX to the Microsoft Store through the Store Submission API.
 *
 * Why this exists: a Store-installed app cannot update itself. The package
 * directory is read-only and the Store owns delivery, so `canAutoUpdate` is
 * false under package identity (`src/main/notifications/updater-service.ts`).
 * That means the releases every other channel receives automatically reach
 * Store users only if someone uploads the package and submits it, which is the
 * step this script automates.
 *
 * The API is documented at
 * learn.microsoft.com/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services
 * and the flow is fixed:
 *
 *   1. POST /v1.0/my/applications/{applicationId}/submissions
 *      Creates a submission by copying the last one, so the listing copy, age
 *      ratings and pricing carry over and only the package is replaced.
 *   2. PUT <submission.fileUploadUrl> with the .msix bytes
 *   3. PUT /submissions/{id} with the new `applicationPackages` entry
 *   4. POST /submissions/{id}/commit, then poll the submission status
 *
 * Two properties of that API shape this script's behaviour. It cannot create an
 * app, and it cannot create the first submission for an app: step 1 needs an
 * existing submission to copy, and the docs require "at least one submission
 * with the age ratings information completed" before it can be called. So the
 * first submission for a product is made once by hand in Partner Center, and
 * every release after that is this script. And because mixing the portal and the
 * API on the same submission strands it (the docs are explicit about that), the
 * script refuses to touch a submission it did not create, which in practice
 * means: once this runs, do not edit that submission in the portal.
 *
 * Credentials come from the environment (GitHub Actions secrets):
 *   STORE_TENANT_ID      Azure AD tenant that owns the Partner Center account
 *   STORE_CLIENT_ID      Azure AD application (client) id
 *   STORE_CLIENT_SECRET  that application's secret
 *   STORE_APP_ID         Store ID of the product, 9NC20ZH8DFCN
 *
 * Usage (from the repository root):
 *   STORE_TENANT_ID=... STORE_CLIENT_ID=... STORE_CLIENT_SECRET=... bun scripts/store-submission.ts
 *   bun scripts/store-submission.ts --dry-run        authenticate and report, change nothing
 *   bun scripts/store-submission.ts --package dist/codeinoven-1.5.66-x64.msix
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The product the package belongs to; Partner Center calls this the Store ID. */
const DEFAULT_APP_ID = '9NC20ZH8DFCN'
const API_ORIGIN = 'https://manage.devcenter.microsoft.com/v1.0'
const TOKEN_HOST = 'https://login.microsoftonline.com'
/** The Store Submission API requires a token minted for its own resource. */
const API_SCOPE = 'https://manage.devcenter.microsoft.com/.default'
/** Statuses after `commit` that mean the submission is out of our hands. */
const ACCEPTED_STATUSES = new Set(['Certification', 'Release', 'Published'])
/** Statuses that mean the submission will not proceed without a human. */
const FAILED_STATUSES = new Set([
  'CommitFailed',
  'PreProcessingFailed',
  'CertificationFailed',
  'ReleaseFailed'
])

type SubmissionPackage = { fileName: string; fileStatus: string }

type SubmissionError = { code?: string; message?: string; details?: string }

type Submission = {
  id: string
  status?: string
  statusDetails?: { errors?: SubmissionError[]; warnings?: SubmissionError[] }
  fileUploadUrl?: string
  applicationPackages?: SubmissionPackage[]
  [key: string]: unknown
}

/** Fields Partner Center owns; they are rejected or ignored when sent back. */
const READ_ONLY_FIELDS = ['id', 'status', 'statusDetails', 'fileUploadUrl'] as const

function write(line: string): void {
  process.stdout.write(`${line}\n`)
}

function fail(message: string): never {
  process.stdout.write(`::error::${message}\n`)
  process.exit(1)
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) continue
    const key = argument.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      flags.set(key, 'true')
    } else {
      flags.set(key, next)
      index += 1
    }
  }
  return flags
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    fail(
      `${name} is not set. The Store Submission API needs an Azure AD application ` +
        'associated with the Partner Center account; see packaging/msix/README.md.'
    )
  }
  return value
}

/**
 * The package to upload.
 *
 * `dist/*.msix` is what `scripts/msix.ts` writes. When both are absent the
 * failure is explicit rather than an upload of nothing.
 */
function findPackage(directory: string): string {
  if (!existsSync(directory)) fail(`No ${directory} directory; build the package first`)
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith('.msix'))
    .map((name) => join(directory, name))
    .filter((path) => statSync(path).isFile())
  if (candidates.length === 0) fail(`No .msix in ${directory}; build the package first`)
  if (candidates.length > 1) {
    fail(`More than one .msix in ${directory}: ${candidates.join(', ')}. Pass --package <path>.`)
  }
  return candidates[0] as string
}

async function accessToken(tenant: string, clientId: string, secret: string): Promise<string> {
  const response = await fetch(`${TOKEN_HOST}/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: secret,
      scope: API_SCOPE
    })
  })
  if (!response.ok) {
    const body = await response.text()
    fail(`Azure AD refused the token request (${response.status}): ${body.slice(0, 400)}`)
  }
  const payload = (await response.json()) as { access_token?: string }
  if (payload.access_token === undefined) fail('Azure AD returned no access_token')
  return payload.access_token
}

async function callApi<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {})
    }
  })
  const body = await response.text()
  if (!response.ok) {
    fail(`${init.method ?? 'GET'} ${path} failed with ${response.status}: ${body.slice(0, 600)}`)
  }
  return body.length === 0 ? ({} as T) : (JSON.parse(body) as T)
}

/** The submission with the fields Partner Center fills in removed. */
function toRequestBody(submission: Submission, packages: SubmissionPackage[]): string {
  const body: Record<string, unknown> = { ...submission }
  for (const field of READ_ONLY_FIELDS) delete body[field]
  body.applicationPackages = packages
  return JSON.stringify(body)
}

async function uploadPackage(uploadUrl: string, path: string): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
  write(`  uploading ${(bytes.length / 1024 / 1024).toFixed(1)} MiB`)
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      // Azure blob storage rejects the upload without an explicit blob type.
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': 'application/octet-stream'
    },
    body: bytes
  })
  if (!response.ok) {
    fail(`Package upload failed with ${response.status}: ${(await response.text()).slice(0, 400)}`)
  }
}

function reportErrors(label: string, errors: SubmissionError[] | undefined): void {
  if (errors === undefined || errors.length === 0) return
  for (const error of errors) {
    write(
      `  ${label}: ${error.code ?? 'unknown'} ${error.message ?? ''} ${error.details ?? ''}`.trim()
    )
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(Bun.argv.slice(2))
  const dryRun = flags.has('dry-run')
  const appId = flags.get('app-id') ?? process.env.STORE_APP_ID ?? DEFAULT_APP_ID
  const packagePath = flags.get('package') ?? findPackage(flags.get('out') ?? 'dist')
  const pollSeconds = Number(flags.get('poll-seconds') ?? 900)

  write(`Store product   = ${appId}`)
  write(`package         = ${packagePath}`)
  write(`mode            = ${dryRun ? 'dry run (nothing is submitted)' : 'submit'}`)

  const token = await accessToken(
    requireEnv('STORE_TENANT_ID'),
    requireEnv('STORE_CLIENT_ID'),
    requireEnv('STORE_CLIENT_SECRET')
  )
  write('authenticated with Azure AD')

  if (dryRun) {
    const existing = await callApi<{ value?: Array<{ id: string; status?: string }> }>(
      `/my/applications/${appId}/submissions`,
      token
    ).catch((error: unknown) => {
      // A product with no submissions at all is the expected first-run state.
      write(`no submissions to read yet: ${String(error).slice(0, 200)}`)
      return { value: [] }
    })
    const latest = existing.value?.[0]
    write(
      latest === undefined
        ? 'the product has no API-reachable submission yet, which is expected before the first one is published'
        : `latest submission ${latest.id} is ${latest.status ?? 'unknown'}`
    )
    return
  }

  const submission = await callApi<Submission>(`/my/applications/${appId}/submissions`, token, {
    method: 'POST'
  })
  write(`created submission ${submission.id} (${submission.status ?? 'no status'})`)
  if (submission.fileUploadUrl === undefined) {
    fail('The created submission has no fileUploadUrl, so the package cannot be uploaded')
  }

  await uploadPackage(submission.fileUploadUrl, packagePath)

  const name = packagePath.split('/').pop() ?? 'package.msix'
  const updated = await callApi<Submission>(
    `/my/applications/${appId}/submissions/${submission.id}`,
    token,
    {
      method: 'PUT',
      body: toRequestBody(submission, [{ fileName: name, fileStatus: 'PendingUpload' }])
    }
  )
  write(`attached ${name}; submission is ${updated.status ?? 'unknown'}`)
  reportErrors('error', updated.statusDetails?.errors)
  reportErrors('warning', updated.statusDetails?.warnings)

  const commit = await callApi<Submission>(
    `/my/applications/${appId}/submissions/${submission.id}/commit`,
    token,
    { method: 'POST' }
  )
  write(`committed; status ${commit.status ?? 'unknown'}`)

  const deadline = Date.now() + pollSeconds * 1000
  let status = commit.status ?? 'unknown'
  while (Date.now() < deadline) {
    if (ACCEPTED_STATUSES.has(status)) break
    if (FAILED_STATUSES.has(status)) {
      const current = await callApi<Submission>(
        `/my/applications/${appId}/submissions/${submission.id}`,
        token
      )
      reportErrors('error', current.statusDetails?.errors)
      fail(`Submission ${submission.id} ended in ${status}; see the errors above`)
    }
    await Bun.sleep(30_000)
    const current = await callApi<Submission>(
      `/my/applications/${appId}/submissions/${submission.id}`,
      token
    )
    status = current.status ?? status
    write(`  status ${status}`)
  }

  if (!ACCEPTED_STATUSES.has(status)) {
    fail(
      `Submission ${submission.id} was still ${status} after ${pollSeconds}s. It is committed ` +
        'and Partner Center continues without us; check the submission in Partner Center.'
    )
  }
  write(`Submission ${submission.id} is ${status}; the Store will publish it.`)
}

if (import.meta.main) {
  await main()
}
