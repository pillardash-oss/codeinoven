import { IMAGE_DESCRIPTOR_INPUT_SCHEMA, IMAGE_DESCRIPTOR_TOOL_NAME } from './image-descriptor'
import { UTILITY_KIND_VALUES } from './types'

/** Stable app-owned gateway tool names. */
export const UTILITY_SEARCH_TOOL_NAME = 'utility_search'
export const UTILITY_ACTIVATE_TOOL_NAME = 'utility_activate'
export const UTILITY_INVOKE_TOOL_NAME = 'utility_invoke'

/** One tool the utility gateway MCP exposes to agents. */
export interface GatewayToolDefinition {
  /** MCP tool name the agent calls via `tools/call`. */
  name: string
  /** Description shown to agents and in the renderer tool catalog. */
  description: string
  /** JSON schema accepted by the tool call. */
  inputSchema: Record<string, unknown>
  /** HTTP bridge route handled by the main-process gateway server. */
  route: string
  /** When the tool is relevant, surfaced in the renderer tool catalog. */
  sentWhen: string
}

/**
 * Canonical catalog of every tool the utility gateway MCP advertises. The
 * gateway script (tools/list + tools/call routing), the main-process bridge
 * dispatch, and `APPLICATION_AGENT_TOOLS` are all derived from this one array,
 * so a tool added here appears everywhere and a tool removed disappears
 * everywhere — no surface can silently drift out of sync again.
 */
export const GATEWAY_TOOLS: GatewayToolDefinition[] = [
  {
    name: UTILITY_SEARCH_TOOL_NAME,
    description:
      'Search app-managed MCP servers, skills, web services, and computer-use capabilities when a skill or MCP is not directly available. Only conclude something does not exist after a search returns no relevant result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Capability or task to search for.' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: [...UTILITY_KIND_VALUES] }
        },
        limit: { type: 'number', minimum: 1, maximum: 20 }
      },
      additionalProperties: false
    },
    route: '/search',
    sentWhen: 'Every agent turn; search first when a needed skill or MCP is not directly available'
  },
  {
    name: UTILITY_ACTIVATE_TOOL_NAME,
    description:
      'Activate one installed utility for the current turn and inspect the operations it exposes.',
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: { type: 'string', description: 'Installed utility identifier.' }
      },
      required: ['utility_id'],
      additionalProperties: false
    },
    route: '/activate',
    sentWhen: 'After utility_search selects an installed capability'
  },
  {
    name: UTILITY_INVOKE_TOOL_NAME,
    description: 'Invoke an operation on a utility activated for the current turn.',
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: { type: 'string' },
        operation: { type: 'string' },
        input: { type: 'object', additionalProperties: true }
      },
      required: ['utility_id', 'operation'],
      additionalProperties: false
    },
    route: '/invoke',
    sentWhen: 'After a utility has been activated for the current turn'
  },
  {
    name: IMAGE_DESCRIPTOR_TOOL_NAME,
    description:
      'Describe one or more images with a vision-capable model so a text-only model (one without vision) can reason about their contents. Provide each image as an entry with a unique id, a source, and a type: "path" when the source is a file path or URL the model can read, or "binary" when the source is base64 image data. The tool accepts up to 8 images per call, so batch several frames at once; call it again for more. If the media is a video the model cannot read, extract frames with ffmpeg first and pass them as separate image entries. The description runs the thread\u2019s (or the app\u2019s configured) image descriptor vision model. Returns a text description per image, tagged with its id.',
    inputSchema: IMAGE_DESCRIPTOR_INPUT_SCHEMA,
    route: '/image_descriptor',
    sentWhen:
      'Whenever a model receives an image it cannot see directly and needs to reason about its contents'
  }
]

/** Map every gateway tool route to its MCP tool name. */
export const GATEWAY_ROUTES: ReadonlyMap<string, string> = new Map(
  GATEWAY_TOOLS.map(({ route, name }) => [route, name])
)
