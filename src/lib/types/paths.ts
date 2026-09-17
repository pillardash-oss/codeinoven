/** What an OS-supplied path resolved to when CodeInOven was asked to open it. */
export type OpenedPathKind = 'directory' | 'file'

/**
 * One folder or file the operating system handed to CodeInOven (Finder/Explorer
 * "Open With", a drop on the Dock/taskbar icon, or a command-line path). The
 * path is canonical (`realpath`) so it can be matched against stored project
 * paths without registering the same folder twice.
 */
export interface OpenedPath {
  path: string
  kind: OpenedPathKind
  name: string
}
