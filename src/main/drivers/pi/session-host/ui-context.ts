/**
 * The extension UI context a hosted session runs with.
 *
 * Pi's interactive surface (select, confirm, input, notify, editor) is turned
 * into lines on the host protocol, so the app answers them exactly the way it
 * answers a permission or question card from a `pi --mode rpc` process. Nothing
 * renders inside the host: there is no terminal there.
 *
 * Everything that belongs to a TUI (footer, header, widgets, editor component,
 * terminal input) is a deliberate no-op, because those have no meaning in a
 * headless host and a hosted session must never block on one.
 */
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { Theme } from '@earendil-works/pi-coding-agent'

import type { HostUiRequest, HostUiResponse } from './protocol'

export type { HostUiRequest, HostUiResponse }

const DEFAULT_DIALOG_TIMEOUT_MS = 5 * 60_000

/**
 * A theme that exists only so the extension context can be built.
 *
 * Pi's runner spreads the UI context when it binds extensions, and its own theme
 * module is not reachable from outside the package (the exports map allows only
 * the root and the RPC entry), so a host cannot obtain a real terminal theme. This
 * stand-in answers styling reads with an empty string and carries a name. Nothing
 * ever renders it: a hosted session has no terminal. The double cast is the one
 * place in this host where a value is asserted rather than constructed, and it is
 * here because the alternative is not sending extension dialogs at all.
 */
const HEADLESS_THEME = new Proxy({} as Record<string, unknown>, {
  get: (_target, property) => (property === 'name' ? 'cio-host' : () => '')
}) as unknown as Theme

export interface UiContextOptions {
  /** Prefix for every request id, normally the session key. */
  idPrefix?: string
}

export interface UiContextHost {
  /** Send one request to the app and wait for its answer. */
  ask(request: HostUiRequest): Promise<HostUiResponse>
  /** A notification needs no answer. */
  notify(request: Extract<HostUiRequest, { method: 'notify' }>): void
  /** Status text needs no answer either, and the app reads it as a state line. */
  status?(request: Extract<HostUiRequest, { method: 'setStatus' }>): void
}

/** Build the context a session binds its extensions with. */
export function createHostUiContext(
  host: UiContextHost,
  options: UiContextOptions = {}
): ExtensionUIContext {
  let requestSequence = 0
  const nextId = (): string => {
    requestSequence += 1
    return `${options.idPrefix ?? 'ui'}-${requestSequence}`
  }

  const ask = async (
    request: Omit<Extract<HostUiRequest, { method: 'select' }>, 'id'>
  ): Promise<HostUiResponse> => host.ask({ ...request, id: nextId() })

  const context: ExtensionUIContext = {
    theme: HEADLESS_THEME,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'A hosted session has no theme to switch' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
    custom: async <T>(): Promise<T> => {
      throw new Error('A hosted session cannot show a custom component')
    },

    async select(title, options, opts) {
      const response = await ask({
        method: 'select',
        title,
        options,
        timeout: opts?.timeout ?? DEFAULT_DIALOG_TIMEOUT_MS
      })
      return 'value' in response ? response.value : undefined
    },
    async confirm(title, message, opts) {
      const response = await host.ask({
        id: nextId(),
        method: 'confirm',
        title,
        message,
        timeout: opts?.timeout ?? DEFAULT_DIALOG_TIMEOUT_MS
      })
      return 'confirmed' in response ? response.confirmed : false
    },
    async input(title, placeholder, opts) {
      const response = await host.ask({
        id: nextId(),
        method: 'input',
        title,
        placeholder,
        timeout: opts?.timeout ?? DEFAULT_DIALOG_TIMEOUT_MS
      })
      return 'value' in response ? response.value : undefined
    },
    async editor(title, prefill) {
      const response = await host.ask({ id: nextId(), method: 'editor', title, prefill })
      return 'value' in response ? response.value : undefined
    },
    notify(message, type) {
      host.notify({ id: nextId(), method: 'notify', message, notifyType: type })
    },
    // The rest of the UI context belongs to an interactive terminal that a hosted
    // session does not have. `never` parameters keep each one assignable to its
    // declared signature without inventing a component or a theme.
    onTerminalInput: () => () => undefined,
    setStatus(key, text) {
      host.status?.({ id: nextId(), method: 'setStatus', statusKey: key, statusText: text })
    },
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: (..._args: never[]) => undefined,
    setFooter: (..._args: never[]) => undefined,
    setHeader: (..._args: never[]) => undefined,
    setTitle: () => undefined,
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => '',
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined
  } as ExtensionUIContext

  return context
}
