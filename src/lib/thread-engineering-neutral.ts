import type { ThreadSettings } from './types'

/**
 * Settings a brand-new thread must never carry over from the thread that
 * spawned it.
 *
 * Engineering is a set of stages the agent turns on from the user's own
 * request, so a sibling thread created beside an Engineering thread starts
 * neutral: no Assignment mode and no Achievement loop mode. Copying those flags
 * used to make a fresh thread behave like an approved implementation run the
 * moment its lifecycle row was inherited, without any stage ever being chosen.
 *
 * Everything else (harness, model, permission level, oven, scope) is still the
 * user's configuration and travels with the new thread.
 */
export function neutralEngineeringThreadSettings(settings: ThreadSettings): ThreadSettings {
  return {
    ...settings,
    assignmentMode: false,
    loopMode: false
  }
}
