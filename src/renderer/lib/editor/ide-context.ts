/**
 * The word and position an IDE action was asked about.
 *
 * It deliberately carries no document text. Reading the buffer here meant a
 * full copy of the file on every click, mousemove and keybinding, which froze
 * the window on a heavy file before the action had even started, and the copy
 * was the same string the editor already holds as its `value` prop.
 */
export interface IdeToken {
  line: number
  character: number
  word: string
  x: number
  y: number
}
export interface IdeMenuAction {
  label: string
  run: () => void
}
const providers = new WeakMap<HTMLElement, (event: MouseEvent) => IdeMenuAction[]>()
export function registerIdeContext(
  host: HTMLElement,
  provider: (event: MouseEvent) => IdeMenuAction[]
): () => void {
  providers.set(host, provider)
  return () => providers.delete(host)
}
export function ideContextActions(event: MouseEvent): IdeMenuAction[] {
  const host =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-editor-codemirror]')
      : null
  return host ? (providers.get(host)?.(event) ?? []) : []
}
