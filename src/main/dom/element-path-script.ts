/**
 * The CSS-path builder shared by every script the app injects into a page.
 *
 * Two page-side scripts need to name an element the same way: the inspector, so a
 * comment can find the element again, and the design-state discovery, so a canvas
 * frame can click the trigger that opens a state. A second copy of the rule would
 * mean two spellings of one element, and a comment pinned to a selector the canvas
 * never clicks.
 *
 * Kept as source text rather than a function because an injected script is a
 * string evaluated in the page's own world: there is no module system there to
 * import from. The text is plain ES5 with no template literals of its own, so it
 * can be interpolated into either script safely.
 *
 * What it produces: a path from the nearest ancestor with a unique id, or from the
 * body, with the first two classes of each step and an `nth-of-type` index when a
 * parent holds siblings of the same tag. Eight steps at most, because a path is
 * read by a human as often as it is evaluated.
 */
export const ELEMENT_PATH_SOURCE = `function escapeId(value) {
  return globalThis.CSS && CSS.escape ? CSS.escape(String(value)) : String(value);
}
function elementPath(element) {
  const doc = (element && element.ownerDocument) || document;
  const parts = [];
  let node = element;
  while (node && node.nodeType === 1 && parts.length < 8) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      const id = escapeId(node.id);
      try {
        if (doc.querySelectorAll('#' + id).length === 1) {
          parts.unshift(part + '#' + id);
          break;
        }
      } catch (error) {}
      part += '#' + id;
    }
    const classes = (node.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (classes.length > 0) part += '.' + classes.map(escapeId).join('.');
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}`
