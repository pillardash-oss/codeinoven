import type { Component } from 'svelte'

export type ActionId = `${string}:${string}`

export type ActionCategory =
  | 'navigation'
  | 'model'
  | 'reasoning'
  | 'mode'
  | 'command'
  | 'skill'
  | 'mcp'
  | 'target'
  | 'file'
  | 'thread'
  | 'other'

export type ActionSourceKind = 'app' | 'harness' | 'plugin'

export interface ActionSource {
  id: string
  label: string
  kind: ActionSourceKind
}

export interface ActionDefinition {
  id: ActionId
  title: string
  description?: string
  category: ActionCategory
  source: ActionSource
  keywords?: readonly string[]
  shortcut?: readonly string[]
  disabledReason?: string
  /** Optional lucide icon rendered in place of the category letter badge. */
  icon?: Component
}

export interface ActionSelection {
  action: ActionDefinition
  query: string
  method: 'keyboard' | 'pointer'
}

export interface ActionFilterOptions {
  limit?: number
  categories?: readonly ActionCategory[]
  sources?: readonly string[]
}
