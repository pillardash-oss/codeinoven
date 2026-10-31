/**
 * The app-owned capability a turn cites its produced work through.
 *
 * A turn that writes a report, a folder of scripts, or a document knows what it
 * produced and where it put it; the app does not. Announcing that work used to be
 * the app's guess from the settled answer, which either invented a deliverable or
 * dropped one. So the turn declares it: it activates this capability and calls
 * `cite_report` with the workspace-relative paths it produced, and the app turns
 * those paths into the conversation's cards when the turn settles.
 *
 * Every card is the app's own shape (name, last modified, one open action), so a
 * cited folder and a cited Markdown file read the same, and nothing about the
 * storage layout reaches the reader.
 *
 * Pure and dependency-free, so the main-process resolver and the renderer's card
 * read the same rules.
 */

/** The capability's model-facing name, shown wherever it is listed. */
export const CITE_CAPABILITY_NAME = 'cio-cite-report'

/** One-line summary shown beside the capability's name. */
export const CITE_CAPABILITY_SUMMARY =
  'Cite the reports, documents and folders a turn produced, so the conversation shows each one as a card the user can open.'

/** How many entries one turn may cite. */
export const CITE_ENTRY_LIMIT = 12

/** Ceiling for one cited path, so a pasted blob can never be a path. */
export const CITE_PATH_LIMIT = 1024

export const CITE_CAPABILITY_DOCS = `---
name: cio-cite-report
description: ${CITE_CAPABILITY_SUMMARY}
---

# Cited work

## Trigger

Use this when a turn produced something the user will open again outside the
answer itself: a report, a document, a script folder, a generated project, a set
of assets. Cite it as you finish the turn, before your final message.

Do not cite what you only talked about. A cited path that does not exist is
dropped, and a card for something the user never received is worse than no card.

## Call

Activate this capability, then call it once with every path you produced:

\`\`\`
cio_util_use({
  utility_id: "cio:cite-report",
  operation: "cite_report",
  input: { paths: ["oracle-free", "oracle-free/README.md"] }
})
\`\`\`

- Paths are relative to this turn's workspace (the project root, the chat's own
  directory, or the assistant's workspace). Never pass an absolute path.
- A directory is cited as the directory. Do not list its children as well.
- Up to ${CITE_ENTRY_LIMIT} entries per turn.

## What the user sees

The app publishes one row under your answer when the turn settles, with a card
per cited entry: its name, when it was last modified, and an **Open** action that
reveals it. Nothing about the path is printed in your message, and you never
describe the card yourself: say what you made, and let the cards carry where it
lives.
`

/** The single operation the capability exposes. */
export const CITE_OPERATIONS = [
  {
    name: 'cite_report',
    description:
      'Cite the files and folders this turn produced, so the conversation shows a card the user can open for each one. Paths are workspace-relative. Call it once with everything you produced, before your final message.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: CITE_ENTRY_LIMIT,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: CITE_PATH_LIMIT
          },
          description:
            'Workspace-relative paths of the files and folders to show. A folder stands for itself, so its children are not listed as well.'
        }
      },
      required: ['paths'],
      additionalProperties: false
    }
  }
] as const

/** One entry the app can draw as a card. */
export interface CitedEntry {
  /** The name the card leads with: the file or folder's own name, or a title. */
  name: string
  /** Workspace-relative path the card opens. */
  path: string
  /** A folder opens in the file tree; a file opens in the file viewer. */
  kind: 'file' | 'directory'
  /** Last modification time of the entry on disk. */
  modifiedAt: number
}

/**
 * The card's name for a cited path: the last real segment.
 *
 * A cited folder is often written with a trailing slash, and a cited file may be
 * written with a leading `./`, so both are normalized here rather than at every
 * call site. When nothing is left, the path itself is the name.
 */
export function citedEntryName(path: string): string {
  const trimmed = path.replace(/\/+$/u, '')
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return segment.length > 0 ? segment : trimmed
}

/**
 * Normalize a cited path into a workspace-relative form, or null when it can
 * never resolve: an absolute path, a parent escape, or an empty string.
 *
 * The workspace root is the only place the app resolves against, so a path that
 * tries to leave it is refused here instead of becoming a card that opens
 * nothing.
 */
export function normalizeCitedPath(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > CITE_PATH_LIMIT) return null
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(trimmed) || trimmed.startsWith('~')) {
    return null
  }
  const segments = trimmed
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  return segments.join('/')
}
