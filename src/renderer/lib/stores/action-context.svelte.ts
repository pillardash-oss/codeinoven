import type { ActionDefinition, ActionSelection } from '../actions'

export type ActionSelectionHandler = (selection: ActionSelection) => void | Promise<void>

/**
 * Thread-scoped actions and their executor.
 *
 * The owner should register whenever its action context becomes active and use
 * the returned cleanup function when it is replaced or unmounted.
 */
export interface ActionContextRegistration {
  actions: readonly ActionDefinition[]
  onSelect: ActionSelectionHandler
}

const EMPTY_ACTIONS: readonly ActionDefinition[] = []

class ActionContextStore {
  current = $state.raw<ActionContextRegistration | null>(null)
  private activeToken: symbol | null = null

  get actions(): readonly ActionDefinition[] {
    return this.current?.actions ?? EMPTY_ACTIONS
  }

  /**
   * Replace the active context and return an identity-safe cleanup.
   *
   * A stale cleanup cannot clear a newer registration, which is important when
   * keyed thread views unmount after the next view has already registered.
   */
  register(registration: ActionContextRegistration): () => void {
    const token = Symbol('action-context')
    this.activeToken = token
    this.current = {
      actions: [...registration.actions],
      onSelect: registration.onSelect
    }

    return () => {
      if (this.activeToken !== token) return
      this.activeToken = null
      this.current = null
    }
  }
}

export const actionContext = new ActionContextStore()
