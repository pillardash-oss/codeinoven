/**
 * Measuring a page: where an element is, where a frame sits, and where the pointer
 * has to go to reach either.
 *
 * A browser delivers input to the top document's viewport, one coordinate space,
 * while a page is made of documents nested inside one another and elements drawn
 * inside shadow roots. Everything here exists to cross those boundaries: a point is
 * measured in its own document, then carried out through every parent's inset, and a
 * hit test descends into the shadow roots the point lands in so the element that
 * answers is the one the pointer would actually touch.
 */

import { MAX_VALUE_CHARS, pageRuntimeSource } from './page-toolkit'

/**
 * Where on screen one element is, and whether it is reachable at all.
 *
 * The point is what a real mouse event is aimed at, so it is measured after the
 * element is scrolled into view and it is rejected when something else covers it.
 * `coveredBy` names what did: without it an agent knows only that its click did not
 * land, never that a dropdown was in the way.
 */
export function agentElementPointScript(selector: string): string {
  return `(() => {
    ${pageRuntimeSource()}
    const element = resolveElement(${JSON.stringify(selector)});
    if (!element) return { found: false, reason: 'not found' };
    return elementPoint(element);
  })()`
}

/** The element's own page-space rectangle, for an element screenshot. */
export function agentElementRectScript(selector: string): string {
  return `(() => {
    ${pageRuntimeSource()}
    const element = resolveElement(${JSON.stringify(selector)});
    if (!element) return null;
    try { element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
    catch { element.scrollIntoView(); }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.x + window.scrollX,
      y: rect.y + window.scrollY,
      width: rect.width,
      height: rect.height,
      box: boxOf(element)
    };
  })()`
}

/**
 * Scroll one point of the page, or bring an element into view.
 *
 * An element inside a scrolling container is scrolled in that container, and an
 * element inside a shadow root is reached the same way, because the element itself
 * is resolved before anything is asked of the window.
 */
export function agentScrollScript(request: {
  selector?: string
  deltaX: number
  deltaY: number
  to?: 'top' | 'bottom'
}): string {
  return `(() => {
    ${pageRuntimeSource()}
    const selector = ${JSON.stringify(request.selector ?? '')};
    const to = ${JSON.stringify(request.to ?? '')};
    if (selector) {
      const element = resolveElement(selector);
      if (!element) return { scrolled: false, reason: 'not found' };
      const scroller = element === document.documentElement || element === document.body;
      if (!scroller) {
        if (to === 'bottom') element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
        else if (to === 'top') element.scrollTo({ top: 0, behavior: 'instant' });
        else {
          try { element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }
          catch { element.scrollIntoView(); }
        }
        if (element.scrollBy) {
          element.scrollBy({ left: ${JSON.stringify(request.deltaX)}, top: ${JSON.stringify(request.deltaY)}, behavior: 'instant' });
        }
        const rect = element.getBoundingClientRect();
        return {
          scrolled: true,
          box: boxOf(element),
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          scrollTop: Math.round(element.scrollTop || 0)
        };
      }
    }
    if (to === 'bottom') window.scrollTo({ top: (document.scrollingElement || document.documentElement).scrollHeight, behavior: 'instant' });
    else if (to === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
    else window.scrollBy({ left: ${JSON.stringify(request.deltaX)}, top: ${JSON.stringify(request.deltaY)}, behavior: 'instant' });
    return { scrolled: true, x: Math.round(window.scrollX), y: Math.round(window.scrollY) };
  })()`
}

/** The size of the area the page is actually shown in, in page pixels. */
export function agentViewportScript(): string {
  return `({ width: window.innerWidth, height: window.innerHeight })`
}

/**
 * How far the page's own document is scrolled.
 *
 * A frame element is measured in the viewport, while an element screenshot is
 * clipped in the document's own coordinates, so the difference between the two is
 * the page's scroll offset. Without it a capture of an element inside a frame on a
 * scrolled page would show whatever happened to sit at those numbers.
 */
export function agentPageOffsetScript(): string {
  return `({ x: window.scrollX, y: window.scrollY })`
}

/**
 * One `<iframe>` or `<frame>` a document hosts, measured in that document.
 *
 * Read by the parent, never by the frame itself: a cross-origin frame cannot ask
 * its own `frameElement` where it sits, and it cannot see the inset it is drawn
 * at. The parent can, and that is what turns a point inside a frame into a point
 * the browser's input pipeline can deliver.
 */
export interface AgentFrameRect {
  index: number
  x: number
  y: number
  width: number
  height: number
  src: string
  title: string
}

/** Measure every frame element a document hosts, in document order. */
export function agentFrameRectsScript(): string {
  return `(() => {
    const frames = Array.from(document.querySelectorAll('iframe, frame'));
    return frames.map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        src: element.src || element.getAttribute('src') || '',
        title: element.getAttribute('title') || element.getAttribute('aria-label') || ''
      };
    });
  })()`
}

/**
 * Bring one frame element into view in its parent, then report where it landed.
 *
 * A frame the caller cannot see is a frame whose point the pointer cannot reach,
 * so the parent is scrolled first and the rectangle is read after it moved.
 */
export function agentFrameRevealScript(index: number): string {
  return `(() => {
    const frames = Array.from(document.querySelectorAll('iframe, frame'));
    const element = frames[${JSON.stringify(index)}];
    if (!element) return null;
    try { element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); }
    catch { element.scrollIntoView(); }
    const rect = element.getBoundingClientRect();
    return {
      index: ${JSON.stringify(index)},
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      src: element.src || element.getAttribute('src') || '',
      title: element.getAttribute('title') || element.getAttribute('aria-label') || ''
    };
  })()`
}

/**
 * Every floating layer the page is showing, with the text it carries.
 *
 * A menu, a picker's list, a dialog and a tooltip are drawn as layers over the page
 * rather than inside the form they belong to, often in a portal at the end of the
 * body and often inside a shadow root. Reading them as a list is what lets an agent
 * act on a control that only exists while a layer is open.
 */
export function agentLayersScript(): string {
  return `(() => {
    ${pageRuntimeSource()}
    const layers = layerList();
    return {
      count: layers.length,
      layers: layers.slice(0, 32).map((layer) => ({
        role: layer.role,
        ref: referenceFor(layer.node),
        selector: deepSelector(layer.node),
        label: labelOf(layer.node),
        box: boxOf(layer.node),
        text: textOf(layer.node, ${MAX_VALUE_CHARS})
      }))
    };
  })()`
}
