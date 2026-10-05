import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { piCioCoreToolsExtension } from '../../../src/main/drivers/pi-cio-core-tools-extension'
import { piMcpServersExtension } from '../../../src/main/drivers/pi-mcp-servers-extension'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

interface McpHookEvent {
  toolName?: string
}

interface StubExtensionApi {
  registerMcpServer: (name: string, config: Record<string, unknown>) => void
  unregisterMcpServer: (name: string) => void
  on: (event: string, handler: (event: McpHookEvent) => void) => void
  /** Every registration this extension made, in order, newest last. */
  registrations: Array<{ name: string; config: Record<string, unknown> }>
  unregistrations: string[]
  emit: (event: string, payload?: McpHookEvent) => void
}

/**
 * Load the generated extension from a temp file exactly as pi does, with a
 * document path of our choosing. The fragment imports nothing but `node:fs`, so
 * the real module can be imported here without pi's runtime.
 */
async function loadExtension(
  options: { document?: unknown; raw?: string; withApi?: boolean } = {}
): Promise<{ api: StubExtensionApi; documentPath: string }> {
  const scratch = join(process.cwd(), '.cio', 'tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'pi-mcp-servers-'))
  roots.push(root)
  const documentPath = join(root, 'mcp-servers.json')
  if (options.raw !== undefined) await writeFile(documentPath, options.raw)
  else if (options.document !== undefined) {
    await writeFile(documentPath, JSON.stringify(options.document))
  }
  const source = piMcpServersExtension().replace(
    '__CIO_MCP_SERVERS_PATH__',
    JSON.stringify(documentPath).slice(1, -1)
  )
  const extensionPath = join(root, 'mcp-servers.ts')
  await writeFile(extensionPath, source)
  const handlers = new Map<string, Array<(event: McpHookEvent) => void>>()
  const api = {
    registrations: [] as StubExtensionApi['registrations'],
    unregistrations: [] as string[],
    registerMcpServer: (name: string, config: Record<string, unknown>) => {
      api.registrations.push({ name, config })
    },
    unregisterMcpServer: (name: string) => {
      api.unregistrations.push(name)
    },
    on: (event: string, handler: (event: McpHookEvent) => void) => {
      const existing = handlers.get(event) ?? []
      existing.push(handler)
      handlers.set(event, existing)
    },
    emit: (event: string, payload: McpHookEvent = {}) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    }
  }
  if (options.withApi === false) {
    delete (api as { registerMcpServer?: unknown }).registerMcpServer
    delete (api as { unregisterMcpServer?: unknown }).unregisterMcpServer
  }
  const module = (await import(pathToFileURL(extensionPath).href)) as {
    default: (pi: unknown) => void
  }
  module.default(api)
  return { api, documentPath }
}

/** One document entry as the driver writes it. */
function server(name: string, command: string): Record<string, unknown> {
  return {
    name,
    utilityId: name,
    utilityName: name,
    config: { type: 'stdio', command, exposure: 'codemode' }
  }
}

describe('piMcpServersExtension', () => {
  it('registers nothing when the app has published no document', async () => {
    const { api } = await loadExtension()

    api.emit('session_start')

    expect(api.registrations).toEqual([])
    expect(api.unregistrations).toEqual([])
  })

  it('registers the servers the thread activated, with their config', async () => {
    const { api } = await loadExtension({
      document: { version: 1, servers: [server('svelte_mcp', 'bunx')] }
    })

    api.emit('session_start')

    expect(api.registrations).toEqual([
      { name: 'svelte_mcp', config: { type: 'stdio', command: 'bunx', exposure: 'codemode' } }
    ])
  })

  it('leaves an unchanged server alone and re-registers a changed one', async () => {
    const { api, documentPath } = await loadExtension({
      document: { version: 1, servers: [server('svelte_mcp', 'bunx')] }
    })

    api.emit('before_agent_start')
    api.emit('before_agent_start')
    expect(api.registrations).toHaveLength(1)

    await writeFile(
      documentPath,
      JSON.stringify({ version: 1, servers: [server('svelte_mcp', 'bunx-next')] })
    )
    api.emit('before_agent_start')

    expect(api.registrations).toHaveLength(2)
    expect(api.unregistrations).toEqual([])
  })

  it('drops a server the app stopped publishing', async () => {
    const { api, documentPath } = await loadExtension({
      document: {
        version: 1,
        servers: [server('svelte_mcp', 'bunx'), server('slack', 'npx')]
      }
    })

    api.emit('session_start')
    expect(api.registrations.map((entry) => entry.name)).toEqual(['svelte_mcp', 'slack'])

    await writeFile(documentPath, JSON.stringify({ version: 1, servers: [server('slack', 'npx')] }))
    api.emit('before_agent_start')

    expect(api.unregistrations).toEqual(['svelte_mcp'])
    expect(api.registrations.map((entry) => entry.name)).toEqual(['svelte_mcp', 'slack'])
  })

  it('never touches a registration on a malformed document', async () => {
    // A half-written or corrupt file must not tear down live servers: the next
    // publication is what removes them.
    const { api } = await loadExtension({ raw: '{"version":1,"servers":[{"name":' })

    api.emit('session_start')

    expect(api.registrations).toEqual([])
    expect(api.unregistrations).toEqual([])
  })

  it('reconciles before a script surface runs, so an activation mid-turn lands', async () => {
    const { api, documentPath } = await loadExtension({ document: { version: 1, servers: [] } })

    api.emit('session_start')
    expect(api.registrations).toEqual([])

    // The gateway activation published the utility while the turn was running.
    await writeFile(documentPath, JSON.stringify({ version: 1, servers: [server('slack', 'npx')] }))
    api.emit('tool_call', { toolName: 'bash' })
    expect(api.registrations).toEqual([])

    api.emit('tool_call', { toolName: 'codemode' })
    expect(api.registrations.map((entry) => entry.name)).toEqual(['slack'])
  })

  it('closes every server with the session', async () => {
    const { api } = await loadExtension({
      document: { version: 1, servers: [server('svelte_mcp', 'bunx')] }
    })

    api.emit('session_start')
    api.emit('session_shutdown')

    expect(api.unregistrations).toEqual(['svelte_mcp'])
  })

  it('does nothing on a pi runtime without the registration API', async () => {
    const { api } = await loadExtension({
      document: { version: 1, servers: [server('svelte_mcp', 'bunx')] },
      withApi: false
    })

    api.emit('session_start')
    api.emit('tool_call', { toolName: 'codemode' })
    api.emit('session_shutdown')

    expect(api.registrations).toEqual([])
    expect(api.unregistrations).toEqual([])
  })
})

describe('piCioCoreToolsExtension', () => {
  it('gives both the registration extension and the tool gate the document path', () => {
    const mcpServersPath = '/tmp/cio probe/mcp-servers.json'
    const composed = piCioCoreToolsExtension({
      questionCap: 3,
      gatewayHandoffPath: '/tmp/cio/gateway-handoff.json',
      systemPromptPath: '/tmp/cio/system-prompt.txt',
      historyRecapPath: '/tmp/cio/history-recap.txt',
      allowedToolsPath: '/tmp/cio/allowed-tools.json',
      mcpServersPath,
      oversizedFlagPath: '/tmp/cio/oversized-recovery.json',
      stopFlagPath: '/tmp/cio/stop-request.json',
      subagentWatchPath: '/tmp/cio/watched-subagents.json',
      compactionContextPath: '/tmp/cio/compaction-context.json',
      workerContractPrompt: 'Worker contract'
    })

    expect(composed).not.toContain('__CIO_MCP_SERVERS_PATH__')
    // The extension placeholder is replaced once per reader, and a path with a
    // `$` in it must survive the replacement verbatim.
    expect(composed.split(mcpServersPath)).toHaveLength(3)
    expect(composed).toContain('codeInOvenMcpServersExtension')
  })
})
