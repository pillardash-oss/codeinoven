import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { piUtilityGatewayExtension } from '../../../src/main/drivers/pi-utility-gateway-extension'

/**
 * The generated pi extension is the only transport CodeInOven has for the
 * utility gateway on pi, and the app's invoke route rejects a call that carries
 * both `input` and `inputs`. That contract broke once here: the bridge always
 * sent `input: params.input ?? {}`, so every batched call was refused as "both"
 * no matter what the model passed. These tests load the real generated module,
 * register it against a fake pi, and assert the gateway request body it posts.
 */

interface RegisteredTool {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

interface FakePi {
  registerTool: (tool: RegisteredTool) => void
}

interface LoadedExtension {
  default: (pi: FakePi) => void
}

let root: string
let server: Server
let endpoint: string
let posted: Record<string, unknown>[]
let tools: Map<string, RegisteredTool>

beforeEach(async () => {
  root = await mkdtemp(resolve('.cio/tmp/pi-gateway-invoke-'))
  posted = []
  server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      posted.push(raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {})
      outgoing.writeHead(200, { 'content-type': 'application/json' })
      outgoing.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No server address')
  endpoint = `http://127.0.0.1:${address.port}`

  const handoffPath = join(root, 'gateway-handoff.json')
  await writeFile(handoffPath, JSON.stringify({ url: endpoint, token: 'test-token' }), 'utf8')

  const source = piUtilityGatewayExtension().replace(
    '__HANDOFF_PATH__',
    JSON.stringify(handoffPath).slice(1, -1)
  )
  const modulePath = join(root, 'gateway-extension.mjs')
  await writeFile(
    modulePath,
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: false
    }).outputText,
    'utf8'
  )
  const loaded = (await import(pathToFileURL(modulePath).href)) as LoadedExtension
  tools = new Map()
  loaded.default({
    registerTool: (tool) => {
      tools.set(tool.name, tool)
    }
  })
})

afterEach(async () => {
  await new Promise<void>((closed) => server.close(() => closed()))
  await rm(root, { recursive: true, force: true })
})

function tool(name: string): RegisteredTool {
  const found = tools.get(name)
  if (!found) throw new Error(`The generated extension did not register ${name}`)
  return found
}

describe('generated pi gateway bridge', () => {
  it('posts a batch call as inputs alone', async () => {
    await tool('cio_util_use').execute('call-1', {
      utility_id: 'cio:gateway',
      operation: 'catalog',
      inputs: [{ names: ['cio_util_use'] }, { names: ['cio_util_init'] }]
    })
    expect(posted).toHaveLength(1)
    const body = posted[0] ?? {}
    expect(body['inputs']).toEqual([{ names: ['cio_util_use'] }, { names: ['cio_util_init'] }])
    expect(Object.keys(body)).not.toContain('input')
  })

  it('posts a single call as input alone', async () => {
    await tool('cio_util_use').execute('call-2', {
      utility_id: 'cio:gateway',
      operation: 'catalog',
      input: { names: ['cio_util_use'] }
    })
    const body = posted[0] ?? {}
    expect(body['input']).toEqual({ names: ['cio_util_use'] })
    expect(Object.keys(body)).not.toContain('inputs')
  })

  it('defaults a single call to an empty input object', async () => {
    await tool('cio_util_use').execute('call-3', {
      utility_id: 'cio:gateway',
      operation: 'catalog'
    })
    const body = posted[0] ?? {}
    expect(body['input']).toEqual({})
    expect(Object.keys(body)).not.toContain('inputs')
  })

  it('posts an activation batch as inputs alone', async () => {
    await tool('cio_util_init').execute('call-4', {
      inputs: [{ utility_id: 'cio:gateway' }, { utility_id: 'cio:browser' }]
    })
    const body = posted[0] ?? {}
    expect(body['inputs']).toEqual([{ utility_id: 'cio:gateway' }, { utility_id: 'cio:browser' }])
    expect(Object.keys(body)).not.toContain('utility_id')
  })
})
