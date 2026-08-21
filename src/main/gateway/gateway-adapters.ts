import type { GatewayAdapterDefinition } from '../../lib/gateway-types'

/**
 * App-seeded gateway adapters.
 *
 * These are reviewed in code, never downloaded: an arbitrary manifest that can
 * execute an npm package would be a remote-code-execution plugin ecosystem.
 * A signed-manifest ecosystem may come later; shipping adapters in code keeps
 * the v1 surface honest.
 */
export const GATEWAY_ADAPTERS: Record<string, GatewayAdapterDefinition> = {
  omniroute: {
    id: 'omniroute',
    name: 'OmniRoute',
    description:
      'Local AI router with an OpenAI/Anthropic-compatible API, provider fallbacks and a dashboard.',
    npmPackage: 'omniroute',
    version: '3.8.49',
    binPath: 'dist/server-ws.mjs',
    runtime: 'node',
    serveArgs: [],
    env: {
      NODE_ENV: 'production',
      OMNIROUTE_SERVER_HOST: '127.0.0.1'
    },
    healthPaths: ['/api/monitoring/health', '/api/health'],
    modelsPath: '/v1/models',
    dashboardPath: '/',
    authMode: 'none',
    homepage: 'https://github.com/diegosouzapw/OmniRoute'
  }
}

export function getGatewayAdapter(id: string): GatewayAdapterDefinition | null {
  return GATEWAY_ADAPTERS[id] ?? null
}

/** The single adapter shipped in v1, seeded on first launch. */
export const DEFAULT_GATEWAY_PLUGIN_ID = 'cio-gateway-omniroute'

export const DEFAULT_GATEWAY_ADAPTER_ID = 'omniroute'
