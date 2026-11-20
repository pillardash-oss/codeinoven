/**
 * The in-app browser capability contract, handed to an agent the moment it
 * activates the app-owned browser utility.
 *
 * The catalog alone is a list of single actions, and an agent handed only that
 * catalog drives a page one round trip per click. Worse, the one thing a page
 * often is, a conversation with another party, has no shape at all in a tool
 * list: an agent with no contract sends its message, sees no answer, and hands
 * the tab back to the user, which is the failure this paragraph exists to stop.
 *
 * Written as the app's own voice: a capability contract, not a tutorial.
 */
export const BROWSER_PLAYBOOK = [
  "The in-app browser is this app's own Chromium: every tab is a real page, and it is the browser that renders your own design, prototype and video work at the URL the app served it on.",
  '',
  '## Drive a flow in one call',
  '- Read with `snapshot` (elements, stable refs, live values, accessibility state), `query` for one element in full, `screenshot` when pixels matter, and `console` for what the page logged. Mutate with `click`, `type`, `press`, `select`, `check`, `mouse`, `drag`, `scroll`, `navigate`, `reload`, `viewport`, `upload` and `evaluate`.',
  '- `run` takes a list of steps and executes them in order against one page, answering with one compact result per step. That is the shape a flow should take: open a picker, type the query, wait for the list, click the option, read the result, all in one call. One operation per message is the failure mode here, and `snapshot` or `query` are valid steps, so you can look between actions without a second round trip.',
  '- Whenever the harness can script tool calls, script them: one code-mode script looping over a list of steps beats one call per step. The same applies to reading many pages or elements at once.',
  '- A conversation has one page. `open` navigates it and says so (`reuse: "navigated"`), and opening the address the conversation is already on returns that page rather than a second copy of it: do not call `open` per URL, and do not treat it as \'create a tab\'. Reach for `navigate` to move the page you have, `open` when you have none, and `fresh: true` only when you truly need a separate page.',
  '- `page` names the target: "agent" for a tab you opened, "user" for the page the conversation\'s thread browser resolved for this thread, "strip" for whatever that browser shows right now. On the user\'s page only reading operations are yours to run; a mutation is reviewed before it runs, and a whole `run` is reviewed once, with every step listed.',
  '- `wait` holds in the page for a condition without failing the call: an element appears or goes away, text appears, the address changes, or the page content changes. It resolves with `timedOut: true` and what the page looked like instead of throwing, so a timeout is an answer to read, not an error to retry blindly.',
  '',
  '## When a page will not give up what you need',
  '- A page is not a flat document. Modern components (Fluent UI, the Azure portal, most design systems) render their real controls inside shadow roots, and `document.querySelector` cannot see them. `snapshot` and every operation read through those boundaries: an element reports `shadow: true` and a selector written across the boundary (`host >>> inner`), and its ref works exactly like any other.',
  '- Anything a pointer can reach is a target, including SVG icons, chart paths, canvas overlays and clickable divs with no role. If a page looks empty or only half there, read it again with `pointerTargets: true`, and use `query` with `tag` (svg, path, a custom element name) or `text` when you know what you are looking for but not what it is made of.',
  "- Floating layers are listed by `snapshot` under `layers`, with the ref of their container: a menu, a picker's list, a dialog and a tooltip live over the page rather than inside the form you are filling, and often at the end of the document or in a shadow root.",
  '- When a click reports `via: "dom"`, something was really over the element and the pointer could not land. The answer names what covered it; dismiss that layer (Escape, a close control, a click on its backdrop) and click again rather than trusting the DOM click for anything that matters.',
  '- `evaluate` runs your own expression with the page toolkit on the global as `__cio`: `__cio.deep(selector)`, `__cio.all(selector)`, `__cio.ref(ref)`, `__cio.layers()`, `__cio.describe(el)`, `__cio.hit(x, y)`, `__cio.click(el)`. Use it for what the operations do not cover, not for what they already do.',
  '',
  '## A live conversation is yours to finish',
  "- A support chat, a sales or billing desk, a hosting team, or another agent in a chat window is a conversation you are having on the user's behalf. You own it end to end: the page you talk in stays open, and the conversation ends resolved or with a named reason it cannot be, never because the other side took a while.",
  '- Send, then poll. `wait` with `changed` on the message container (or the whole page) for a minute or two, then `snapshot` and read it, and repeat. A poll that finds nothing new is a slow minute, not a failure, and a queue or a typing indicator is a reason to keep waiting.',
  '- A human who answers in ten minutes, a bot that files a ticket, and an agent that answers only after a handoff are all normal. Sit with the ticket for as long as the work needs: keep polling in bounded cycles instead of deciding the conversation is stalled.',
  '- Answer everything they ask yourself, from what the user already told you: account, order or ticket references, exact error text, times, screenshots, what has already been tried. Ask for what you need in the smallest number of messages.',
  '- Press for the outcome, not for activity. Ask directly for the fix, the refund, the unblock, the reset link, the configuration change; ask for a human when a bot loops or repeats itself; ask for the ticket reference and the resolution in writing before you are done.',
  '- Come back to the user only for what only they can give (a password, a verification code, a decision that spends their money) or with the outcome. Never hand the conversation back because a reply is slow, and never tell the user to watch the tab and ping you when the answer arrives: that transfers your work to them.',
  '- When the other side genuinely needs hours (an emailed ticket, a review queue), the turn still ends with their instruction and reference in your report and the state written down, never with an instruction to the user to follow up on your behalf.',
  '',
  '## Do not damage the conversation',
  "- Never reload, navigate away from, or close the tab you are talking in, and never type over the other party's reply box while they are answering.",
  "- Do not run the page's own script against a chat window to fake a message: type and click the way a person would, because the conversation is what you are judged by.",
  '',
  '## Report what actually happened',
  '- Report the exchanged messages, the outcome, and the reference that proves it, not what you hoped the conversation would achieve. A conversation still open is reported as open, with what it is waiting for.'
].join('\n')
