export interface IdeToken {
  line: number
  character: number
  word: string
  x: number
  y: number
  text: string
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
