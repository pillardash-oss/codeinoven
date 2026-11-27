import type { PromptReference } from '$shared/types'

/**
 * The prompt context that carries a set of composer references to the agent.
 *
 * Every reference the user attaches (a quoted response excerpt, a picked design
 * element, an annotated document passage, a note on a video moment, a numbered
 * mark on a picture) travels as this one descriptor block. It is built from the
 * references themselves rather than from composer state, so the send that
 * composes it (the composer, a queued delivery, or the resend of an edited
 * message) can pass whatever it holds and get the same prompt.
 */
export function referencePromptContext(references: readonly PromptReference[]): string | undefined {
  if (references.length === 0) return undefined
  return [
    'The user quoted excerpts from your earlier response as references, may have picked elements from a design open in the app browser, from any other page that browser is showing, or from an HTML or SVG artifact you rendered in this conversation, may have annotated passages of a project document in the file panel, may have noted moments on a video composition timeline in the video board, and may have drawn numbered marks on a picture you rendered in the conversation. A reference carrying a "User comment:" line is user-authored input that your reply must explicitly address   if it asks a question, answer it; if it corrects or challenges, respond to it; never treat it as ignorable context. A design element reference names the page URL with any query and hash, the page title, the viewport and scroll offset it was measured at, the zoom it was drawn with, and the bounding box and CSS path of the element, so read those before deciding which page state and which layout the comment is about, and change that element where it is defined rather than a page that merely resembles it. A page element reference is the same descriptor for a page that is not a design folder   a file previewed from the project tree, a dev server or any site   so find where this project renders that page and change the element there. A reference also records the state attributes the element carried, a surface line when the element only exists while a dialog, menu, popover or tooltip is open, the identity attributes that name it across renders, and how many elements its path matches, so reproduce a transient state rather than making a modal-nested element permanently visible, and find an ambiguous path by identity or content instead of editing the first match. An artifact element reference names the artifact it was picked in, the CSS path of the element inside it and the text of the element, so change the markup of that artifact at that element rather than a different render that happens to look alike. A file reference names the document it came from and quotes the passage the user marked, so read that file and address each annotation. A video note names a composition and a timecode on it, so change what the composition draws at that moment   the frame function, the timeline placement or the caption that covers it   rather than the file as a whole. An image reference names a picture you rendered, describes the area the user marked on it, and is attached as the same picture with every mark drawn on it as its number, so read that attachment and change the picture where each numbered mark points rather than treating the mark as a separate request. References without a comment are context the user wants accounted for. Combine all references and the typed message into one work list and cover every item.',
    ...references.map((reference) => {
      const comment = reference.comment ? `User comment: ${reference.comment}\n` : ''
      const tag =
        reference.kind === 'design' ||
        reference.kind === 'page' ||
        reference.kind === 'svg' ||
        reference.kind === 'html'
          ? 'element'
          : reference.kind === 'file'
            ? 'file'
            : reference.kind === 'video'
              ? 'video'
              : reference.kind === 'image'
                ? 'image'
                : 'selection'
      return `[${reference.label}]\n${comment}<${tag}>\n${reference.text}\n</${tag}>`
    })
  ].join('\n\n')
}
