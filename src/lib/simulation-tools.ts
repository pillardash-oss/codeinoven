import type { GatewayToolDefinition } from './gateway-tools'

/**
 * The one tool an agent calls to put the device it is working on in front of the
 * user.
 *
 * It is a notification and nothing else. The agent keeps driving the device with
 * its own tools, exactly as those tools document themselves: `adb` for a phone on
 * a cable or on the network, `simctl` and `idb` for a simulator. This tool never
 * boots, taps, types or terminates anything; it tells the renderer which target to
 * mirror so the person can watch and take over. That separation is the whole point:
 * a monitoring call must never change what the agent's device work does.
 *
 * Available through the utility gateway like every other app tool, discovered with
 * the catalog rather than typed from memory.
 */
export const EXT_SIMULATION_TOOL_NAME = 'ext_simulation'

const EXT_SIMULATION_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    platform: {
      type: 'string',
      enum: ['android', 'ios'],
      description:
        'Which kind of device to mirror. android covers an emulator and any device adb reaches, cabled or wireless; ios covers a booted Simulator.'
    },
    device: {
      type: 'string',
      description:
        'The device to mirror, exactly as its own tool names it: an adb serial (`emulator-5554`, a cable serial such as `RZCW61ATJDF`, or `host:port` for a wireless device) or a simulator udid. Omit it when exactly one device of that platform exists and it is the one you are working on.'
    },
    close: {
      type: 'boolean',
      description:
        'Stop mirroring instead of starting it, when the work on the device is finished. The panel closes the preview; the device is untouched.'
    }
  },
  required: ['platform'],
  additionalProperties: false
}

const EXT_SIMULATION_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    mirrored: {
      type: 'object',
      properties: {
        platform: { type: 'string' },
        device: { type: 'string' },
        label: { type: 'string' },
        detail: { type: 'string' }
      },
      additionalProperties: true
    },
    available: {
      type: 'array',
      description:
        'Every device of that platform this machine can mirror right now, with the id to pass next time.',
      items: {
        type: 'object',
        properties: {
          device: { type: 'string' },
          label: { type: 'string' },
          detail: { type: 'string' }
        },
        additionalProperties: true
      }
    },
    message: { type: 'string' }
  },
  required: ['ok'],
  additionalProperties: true
}

export const EXT_SIMULATION_TOOLS: GatewayToolDefinition[] = [
  {
    name: EXT_SIMULATION_TOOL_NAME,
    description:
      'Show the emulator, simulator or adb device you are working on in CodeInOven so the user can watch it and take over the screen. This only opens the display panel on that one device; it never boots, taps, types, installs or stops anything, so keep driving the device with its own tools (adb, simctl, idb) exactly as those tools document, unaffected by this call. Call it once when you start working on a device, and again with close: true when you are done. Pass the platform and the device id your own tool uses (an adb serial, cabled or wireless, or a simulator udid); omit device when exactly one exists. If the device is not available, the result lists the ones that are.',
    inputSchema: EXT_SIMULATION_INPUT_SCHEMA,
    outputSchema: EXT_SIMULATION_RESULT_SCHEMA,
    route: '/ext-simulation',
    sentWhen:
      'When the agent starts, moves, or stops working on an emulator, simulator or adb device'
  }
]
