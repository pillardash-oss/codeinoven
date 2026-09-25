/**
 * The chat composer's draft surface   the rich editor that holds the words the
 * user is writing.
 *
 * `ChatComposer` derives that editor's id from the thread it belongs to
 * (`chat-composer-<projectId>-<threadId>`), which makes the id the app-wide
 * handle for "the composer draft": the command palette also identifies the
 * focused composer editor by the same prefix to bookmark its caret. Surfaces
 * outside the composer (find in conversation) use this selector to fold the
 * draft into their own scope without reaching into the composer component.
 */
export const COMPOSER_DRAFT_SELECTOR = '.rich-markdown-editor[id^="chat-composer-"]'
