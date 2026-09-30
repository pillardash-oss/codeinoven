import { SCREEN_CANVAS_RUNTIME_STYLE_PATH } from '../../lib/design/screen-canvas'

/**
 * The Screen Canvas runtime.
 *
 * A canvas is one page per design that declares its frames and loads this
 * script from the app's reserved path. The script turns that page into a
 * pannable, zoomable artboard: it builds the grid, frames each screen in a
 * same-origin iframe, and owns pan and zoom across the whole surface with the
 * gestures a canvas is expected to have. The wheel pans, cmd or ctrl with the
 * wheel zooms at the pointer, and a space-held drag pans anywhere, including on
 * top of a screen.
 *
 * It is a string function rather than a file because it belongs to the app, not
 * to the design folder. The preview server answers its reserved path on every
 * origin, so a canvas the agent wrote last month behaves exactly like one
 * written today, and improving the runtime never means editing a design that
 * already exists. The composition transport lives the same way for the same
 * reason: the code that owns a page while the app shows it is app code, and it
 * must be reachable without a build step putting a file inside a user's folder.
 *
 * Everything here is plain JavaScript because it runs in the page, with no
 * preload bridge and no external dependencies. The style string sits beside it
 * for the same reason, and the runtime injects it when the canvas does not link
 * it, so the agent only ever has to include the one script tag.
 */

/**
 * The runtime script a canvas page loads from its reserved path.
 *
 * Plain JavaScript in a string, because it is served verbatim into the page.
 * There are no template literals inside: string concatenation keeps the outer
 * template from needing escapes, and no `${` may appear in the body.
 */
export function screenCanvasRuntimeScript(): string {
  return `(function () {
  'use strict';

  var STYLE_PATH = ${JSON.stringify(SCREEN_CANVAS_RUNTIME_STYLE_PATH)};
  var DEFAULT_WIDTH = 1440;
  var MIN_WIDTH = 200;
  var MAX_WIDTH = 4000;
  var MIN_HEIGHT = 240;
  var MAX_HEIGHT = 6000;
  var DEFAULT_HEIGHT = 900;
  var DEFAULT_COLUMNS = 2;
  var MIN_COLUMNS = 1;
  var MAX_COLUMNS = 4;
  var MIN_SCALE = 0.1;
  var MAX_SCALE = 4;
  var FIT_PADDING = 64;
  var RESIZE_DELAY = 200;
  var ZOOM_STEP = 1.25;
  var WHEEL_ZOOM_RATE = 0.002;
  var SETTLE_MS = 3000;

  // A single backslash, built from its code point rather than written as a
  // string escape: the whole runtime is itself a JavaScript string, and an
  // escaped escape here would be read one level too early.
  var BACKSLASH = String.fromCharCode(92);

  var ICON_ZOOM_OUT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.6-3.6"></path>' +
    '<path d="M8 11h6"></path></svg>';
  var ICON_ZOOM_IN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.6-3.6"></path>' +
    '<path d="M8 11h6"></path><path d="M11 8v6"></path></svg>';
  var ICON_FIT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 9V5a1 1 0 0 1 1-1h4"></path><path d="M15 4h4a1 1 0 0 1 1 1v4"></path>' +
    '<path d="M20 15v4a1 1 0 0 1-1 1h-4"></path><path d="M9 20H5a1 1 0 0 1-1-1v-4"></path></svg>';

  function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  function numberFrom(value, fallback) {
    if (value === null || value === undefined) return fallback;
    var parsed = parseFloat(value);
    if (!isFinite(parsed)) return fallback;
    return parsed;
  }

  function integerFrom(value, fallback) {
    var parsed = parseInt(value, 10);
    if (!isFinite(parsed)) return fallback;
    return parsed;
  }

  function trim(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // The label a frame shows when it declares none: the file name without its
  // directory or extension, or "Sketch" for a frame with no file behind it.
  function fileNameOf(entry) {
    var name = String(entry).split(BACKSLASH).join('/');
    var slash = name.lastIndexOf('/');
    if (slash !== -1) name = name.slice(slash + 1);
    var dot = name.lastIndexOf('.');
    if (dot > 0) name = name.slice(0, dot);
    return name !== '' ? name : 'Sketch';
  }

  // The canvas page may link the runtime stylesheet itself; when it does not,
  // the app serves it from the same reserved path and the runtime links it. The
  // link is added as the script runs, before first paint, so the canvas never
  // flashes unstyled.
  function ensureStylesheet() {
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var index = 0; index < links.length; index += 1) {
      var href = links[index].getAttribute('href');
      if (!href) continue;
      if (href === STYLE_PATH) return null;
      try {
        if (new URL(href, document.baseURI).pathname === STYLE_PATH) return null;
      } catch {
        // An href the browser cannot resolve is not the runtime's stylesheet.
      }
    }
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLE_PATH;
    var head = document.head || document.documentElement;
    if (head) head.appendChild(link);
    return link;
  }

  function build() {
    var root = document.querySelector('[data-cio-canvas]');
    // Without the root there is no canvas to build, and the page is left alone.
    if (!root) return;
    // Running twice must never build two canvases over each other.
    if (root.getAttribute('data-cio-canvas-mounted') === 'true') return;
    root.setAttribute('data-cio-canvas-mounted', 'true');

    var columns = clamp(
      integerFrom(root.getAttribute('data-cio-columns'), DEFAULT_COLUMNS),
      MIN_COLUMNS,
      MAX_COLUMNS
    );
    var sections = frameSections(root);

    var surface = root;
    surface.classList.add('cio-canvas-surface');

    var stage = document.createElement('div');
    stage.className = 'cio-canvas-stage';
    var grid = document.createElement('div');
    grid.className = 'cio-canvas-grid';
    grid.style.gridTemplateColumns = 'repeat(' + columns + ', max-content)';
    stage.appendChild(grid);

    // The declared sections were captured first and are still referenced here
    // after the surface is cleared, so their children and attributes survive.
    surface.textContent = '';
    surface.appendChild(stage);

    var scale = 1;
    var panX = 0;
    var panY = 0;
    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    // Space is the hand tool. While it is held the frames stop taking the
    // pointer, so a drag that starts on a screen pans the canvas instead of
    // reaching the page inside it.
    var spaceHeld = false;
    var measureTimer = 0;
    var readout = null;
    var records = [];
    // Until the user touches the view, the canvas keeps fitting itself while it
    // settles: the stylesheet lands after the first paint and the frames report
    // their heights as they load, so the first fit is a guess at the real size.
    // The window is bounded, because a frame that reloads later (the preview
    // server reloads on every file change) must not move the view under the
    // user.
    var userAdjusted = false;
    var settleUntil = Date.now() + SETTLE_MS;

    function viewportWidth() {
      return surface.clientWidth || window.innerWidth;
    }

    function viewportHeight() {
      return surface.clientHeight || window.innerHeight;
    }

    // Screen = pan + world * scale, so the stage transform is translate then
    // scale with the origin at the top-left. The scale is stamped on the root
    // element on every apply: the app's element inspector reads it to map a
    // picked element's rectangle back to the page.
    function applyTransform() {
      stage.style.transform =
        'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
      document.documentElement.dataset.cioCanvasScale = String(scale);
      if (readout) readout.textContent = Math.round(scale * 100) + '%';
    }

    function zoomAt(x, y, factor) {
      var next = clamp(scale * factor, MIN_SCALE, MAX_SCALE);
      if (next === scale) return;
      var worldX = (x - panX) / scale;
      var worldY = (y - panY) / scale;
      scale = next;
      panX = x - worldX * scale;
      panY = y - worldY * scale;
      applyTransform();
    }

    function zoomBy(factor) {
      zoomAt(viewportWidth() / 2, viewportHeight() / 2, factor);
    }

    // Fit every frame with padding, and never zoom past 100%: a small design is
    // shown at its real size rather than blown up to fill the window.
    function fit() {
      var width = grid.offsetWidth;
      var height = grid.offsetHeight;
      if (!width || !height) return;
      scale = clamp(
        Math.min(
          1,
          (viewportWidth() - FIT_PADDING * 2) / width,
          (viewportHeight() - FIT_PADDING * 2) / height
        ),
        MIN_SCALE,
        MAX_SCALE
      );
      panX = viewportWidth() / 2 - (scale * width) / 2;
      panY = viewportHeight() / 2 - (scale * height) / 2;
      applyTransform();
    }

    // Fit again while the canvas is still settling and the user has not taken
    // over: every call before the real layout is a correction of the last one.
    function fitIfUntouched() {
      if (userAdjusted || Date.now() > settleUntil) return;
      fit();
    }

    // 100% is exact, not a float that divided its way back to one: the scale
    // the inspector reads should say 1 when the user asked for 1.
    function resetZoom() {
      if (scale === 1) return;
      var centerX = viewportWidth() / 2;
      var centerY = viewportHeight() / 2;
      var worldX = (centerX - panX) / scale;
      var worldY = (centerY - panY) / scale;
      scale = 1;
      panX = centerX - worldX;
      panY = centerY - worldY;
      applyTransform();
    }

    function beginPan(x, y) {
      dragging = true;
      lastX = x;
      lastY = y;
      surface.classList.add('cio-canvas-panning');
    }

    function movePan(x, y) {
      if (!dragging) return;
      panX += x - lastX;
      panY += y - lastY;
      lastX = x;
      lastY = y;
      applyTransform();
    }

    function endPan() {
      if (!dragging) return;
      dragging = false;
      surface.classList.remove('cio-canvas-panning');
    }

    function isTypingTarget(target) {
      if (!target || !target.tagName) return false;
      var tag = target.tagName.toLowerCase();
      return (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target.isContentEditable === true
      );
    }

    function setSpaceHeld(held) {
      if (held === spaceHeld) return;
      spaceHeld = held;
      surface.classList.toggle('cio-canvas-space', held);
      // The hand is only a hand while the key is down, so releasing space ends
      // the drag it started.
      if (!held) endPan();
    }

    function onSpaceKeyDown(event) {
      if (event.code !== 'Space' && event.key !== ' ') return;
      // A screen with a form in it keeps the space bar for typing.
      if (isTypingTarget(event.target)) return;
      // The surface itself never scrolls, but the page would still scroll
      // behind it and a focused toolbar button would read the key as a press.
      event.preventDefault();
      setSpaceHeld(true);
    }

    function onSpaceKeyUp(event) {
      if (event.code !== 'Space' && event.key !== ' ') return;
      if (isTypingTarget(event.target)) return;
      setSpaceHeld(false);
    }

    function applyWheel(input) {
      if (input.zoom) {
        zoomAt(input.clientX, input.clientY, Math.exp(-input.deltaY * WHEEL_ZOOM_RATE));
      } else {
        panX -= input.deltaX;
        panY -= input.deltaY;
        applyTransform();
      }
    }

    function onSurfaceWheel(event) {
      event.preventDefault();
      userAdjusted = true;
      applyWheel({
        clientX: event.clientX,
        clientY: event.clientY,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        zoom: event.ctrlKey || event.metaKey
      });
    }

    function onSurfacePointerDown(event) {
      if (event.target && event.target.closest && event.target.closest('.cio-canvas-toolbar')) {
        return;
      }
      var onFrame = event.target && event.target.closest && event.target.closest('.cio-canvas-screen');
      var middle = event.button === 1;
      // Left drag pans the background, and pans anywhere at all while space is
      // held. A left press on a frame without space belongs to the frame, so a
      // user can still interact with the screen inside it.
      if (middle || (event.button === 0 && (!onFrame || spaceHeld))) {
        event.preventDefault();
        userAdjusted = true;
        beginPan(event.clientX, event.clientY);
      }
    }

    function onDocumentPointerMove(event) {
      if (!dragging) return;
      movePan(event.clientX, event.clientY);
    }

    // A same-origin frame's own events never reach this document, so the
    // frame window forwards them. Wheel and middle drag are the two gestures
    // that must keep working while the pointer is over a frame.
    function framePoint(record, clientX, clientY) {
      var rect = record.frame.getBoundingClientRect();
      return { x: rect.left + clientX * scale, y: rect.top + clientY * scale };
    }

    function onFrameWheel(record, event) {
      event.preventDefault();
      userAdjusted = true;
      var point = framePoint(record, event.clientX, event.clientY);
      applyWheel({
        clientX: point.x,
        clientY: point.y,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        zoom: event.ctrlKey || event.metaKey
      });
    }

    function onFramePointerDown(record, event) {
      if (event.button !== 1) return;
      event.preventDefault();
      userAdjusted = true;
      var point = framePoint(record, event.clientX, event.clientY);
      beginPan(point.x, point.y);
    }

    function onFramePointerMove(record, event) {
      if (!dragging) return;
      var point = framePoint(record, event.clientX, event.clientY);
      movePan(point.x, point.y);
    }

    function attachFrameWindow(record) {
      var frameWindow = null;
      var frameDocument = null;
      try {
        frameWindow = record.frame.contentWindow;
        frameDocument = frameWindow ? frameWindow.document : null;
      } catch {
        frameWindow = null;
        frameDocument = null;
      }
      if (!frameWindow || !frameDocument) return;
      if (frameDocument === record.document && frameWindow === record.window) return;
      // The frame is attached by detaching first, never by attaching again on
      // top. A frame's window outlives the document it first held: the blank
      // document the element starts with and the screen that replaces it share
      // one window, so attaching on each of them left two sets of listeners on
      // it and every forwarded gesture ran twice, at double speed. Detaching
      // what this record owns is right in both directions: a window that is
      // still the same loses exactly the one set it has, and a window that was
      // replaced has nothing to lose.
      detachFrameWindow(record);
      record.document = frameDocument;
      record.window = frameWindow;
      var handlers = {
        wheel: function (event) { onFrameWheel(record, event); },
        // A key pressed while the pointer is over a screen is delivered to the
        // frame's own document, so the frames report space as well.
        keydown: onSpaceKeyDown,
        keyup: onSpaceKeyUp,
        pointerdown: function (event) { onFramePointerDown(record, event); },
        pointermove: function (event) { onFramePointerMove(record, event); },
        pointerup: endPan,
        pointercancel: endPan
      };
      record.handlers = handlers;
      try {
        frameWindow.addEventListener('wheel', handlers.wheel, { passive: false });
        frameWindow.addEventListener('keydown', handlers.keydown, true);
        frameWindow.addEventListener('keyup', handlers.keyup, true);
        frameWindow.addEventListener('pointerdown', handlers.pointerdown, true);
        frameWindow.addEventListener('pointermove', handlers.pointermove, true);
        frameWindow.addEventListener('pointerup', handlers.pointerup, true);
        frameWindow.addEventListener('pointercancel', handlers.pointercancel, true);
      } catch {
        detachFrameWindow(record);
        record.document = null;
      }
    }

    // The listeners a frame forwards its gestures through, taken off the window
    // they were put on. A window that is already gone needs no cleanup, and one
    // that is still there must keep none of them.
    function detachFrameWindow(record) {
      var frameWindow = record.window;
      var handlers = record.handlers;
      record.window = null;
      record.handlers = null;
      if (!frameWindow || !handlers) return;
      try {
        frameWindow.removeEventListener('wheel', handlers.wheel);
        frameWindow.removeEventListener('keydown', handlers.keydown, true);
        frameWindow.removeEventListener('keyup', handlers.keyup, true);
        frameWindow.removeEventListener('pointerdown', handlers.pointerdown, true);
        frameWindow.removeEventListener('pointermove', handlers.pointermove, true);
        frameWindow.removeEventListener('pointerup', handlers.pointerup, true);
        frameWindow.removeEventListener('pointercancel', handlers.pointercancel, true);
      } catch {
        // A window that refuses the call has nothing of ours left to fire.
      }
    }

    function measureFrame(record) {
      if (record.declaredHeight !== null) return;
      var height = null;
      try {
        var doc = record.frame.contentDocument;
        if (doc && doc.documentElement) {
          var body = doc.body;
          var html = doc.documentElement;
          var candidates = [];
          if (body) candidates.push(body.scrollHeight, body.offsetHeight);
          candidates.push(html.scrollHeight, html.offsetHeight);
          for (var index = 0; index < candidates.length; index += 1) {
            var candidate = candidates[index];
            if (typeof candidate === 'number' && isFinite(candidate) && candidate > 0) {
              if (height === null || candidate > height) height = candidate;
            }
          }
        }
      } catch {
        height = null;
      }
      if (height === null || !isFinite(height) || height <= 0) {
        try {
          height = record.frame.contentWindow ? record.frame.contentWindow.innerHeight : null;
        } catch {
          height = null;
        }
      }
      // A frame that refuses to report its height is shown at the default
      // rather than left collapsed, and every measurement is clamped so a
      // runaway page cannot stretch the canvas.
      if (height === null || !isFinite(height) || height <= 0) height = DEFAULT_HEIGHT;
      record.frame.style.height = Math.round(clamp(height, MIN_HEIGHT, MAX_HEIGHT)) + 'px';
    }

    function scheduleMeasure() {
      if (measureTimer) clearTimeout(measureTimer);
      measureTimer = setTimeout(function () {
        measureTimer = 0;
        for (var index = 0; index < records.length; index += 1) measureFrame(records[index]);
      }, RESIZE_DELAY);
    }

    function buildScreen(section) {
      var frameValue = section.getAttribute('data-cio-frame');
      var entry = trim(frameValue === null ? '' : frameValue);
      var sketch = entry === '' && section.hasAttribute('data-cio-sketch');
      // A frame attribute with nothing in it and no sketch behind it names no
      // screen, so it contributes no frame instead of an empty iframe.
      if (entry === '' && !sketch) return null;

      var declaredTitle = trim(section.getAttribute('data-cio-title'));
      var caption = trim(section.getAttribute('data-cio-caption'));
      var width = Math.round(
        clamp(
          numberFrom(section.getAttribute('data-cio-width'), DEFAULT_WIDTH),
          MIN_WIDTH,
          MAX_WIDTH
        )
      );
      var declaredHeight = section.hasAttribute('data-cio-height')
        ? Math.round(
            clamp(
              numberFrom(section.getAttribute('data-cio-height'), DEFAULT_HEIGHT),
              MIN_HEIGHT,
              MAX_HEIGHT
            )
          )
        : null;

      var screen = document.createElement('article');
      screen.className = 'cio-canvas-screen';
      screen.style.width = width + 'px';
      if (entry !== '') screen.setAttribute('data-cio-screen', entry);

      var bar = document.createElement('div');
      bar.className = 'cio-canvas-bar';
      var labels = document.createElement('div');
      labels.className = 'cio-canvas-bar-labels';
      var title = document.createElement('span');
      title.className = 'cio-canvas-bar-title';
      title.textContent = declaredTitle !== '' ? declaredTitle : sketch ? 'Sketch' : fileNameOf(entry);
      labels.appendChild(title);
      if (caption !== '') {
        var captionNode = document.createElement('span');
        captionNode.className = 'cio-canvas-bar-caption';
        captionNode.textContent = caption;
        labels.appendChild(captionNode);
      }
      bar.appendChild(labels);

      var body = document.createElement('div');
      body.className = 'cio-canvas-body';

      if (sketch) {
        var badge = document.createElement('span');
        badge.className = 'cio-canvas-bar-badge';
        badge.textContent = 'Sketch';
        bar.appendChild(badge);
        body.className = 'cio-canvas-body cio-canvas-body-sketch';
        // A sketch keeps the markup the page wrote: it is drawn content with no
        // screen file behind it, so its children become the frame's content.
        while (section.firstChild) body.appendChild(section.firstChild);
        screen.appendChild(bar);
        screen.appendChild(body);
        grid.appendChild(screen);
        return null;
      }

      var open = document.createElement('a');
      open.className = 'cio-canvas-bar-action';
      open.href = entry;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Open';
      open.title = 'Open ' + entry + ' in a new tab';
      open.setAttribute('aria-label', 'Open ' + entry + ' in a new tab');
      bar.appendChild(open);

      var frame = document.createElement('iframe');
      frame.className = 'cio-canvas-body-frame';
      frame.setAttribute('title', title.textContent);
      frame.setAttribute('src', entry);
      frame.setAttribute('width', String(width));
      frame.style.height = (declaredHeight === null ? DEFAULT_HEIGHT : declaredHeight) + 'px';
      body.appendChild(frame);
      screen.appendChild(bar);
      screen.appendChild(body);
      grid.appendChild(screen);

      var record = {
        frame: frame,
        declaredHeight: declaredHeight,
        document: null,
        window: null,
        handlers: null
      };
      frame.addEventListener('load', function () {
        measureFrame(record);
        attachFrameWindow(record);
        fitIfUntouched();
      });
      measureFrame(record);
      attachFrameWindow(record);
      return record;
    }

    function toolButton(action, label, icon) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'cio-canvas-tool';
      button.setAttribute('data-cio-action', action);
      button.setAttribute('title', label);
      button.setAttribute('aria-label', label);
      button.innerHTML = icon;
      return button;
    }

    function resetButton() {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'cio-canvas-tool cio-canvas-tool-reset';
      button.setAttribute('data-cio-action', 'reset');
      button.setAttribute('title', 'Reset zoom to 100%');
      button.setAttribute('aria-label', 'Reset zoom to 100%');
      button.textContent = '100%';
      return button;
    }

    function buildToolbar() {
      var toolbar = document.createElement('div');
      toolbar.className = 'cio-canvas-toolbar';
      toolbar.setAttribute('role', 'toolbar');
      toolbar.setAttribute('aria-label', 'Canvas view controls');
      toolbar.appendChild(toolButton('zoom-out', 'Zoom out', ICON_ZOOM_OUT));
      var scaleReadout = document.createElement('span');
      scaleReadout.className = 'cio-canvas-readout';
      scaleReadout.setAttribute('aria-live', 'polite');
      scaleReadout.textContent = '100%';
      toolbar.appendChild(scaleReadout);
      toolbar.appendChild(toolButton('zoom-in', 'Zoom in', ICON_ZOOM_IN));
      toolbar.appendChild(toolButton('fit', 'Fit all frames', ICON_FIT));
      toolbar.appendChild(resetButton());
      toolbar.addEventListener('click', function (event) {
        var target =
          event.target && event.target.closest ? event.target.closest('[data-cio-action]') : null;
        if (!target) return;
        userAdjusted = true;
        var action = target.getAttribute('data-cio-action');
        if (action === 'zoom-out') zoomBy(1 / ZOOM_STEP);
        else if (action === 'zoom-in') zoomBy(ZOOM_STEP);
        else if (action === 'fit') fit();
        else if (action === 'reset') resetZoom();
      });
      return { element: toolbar, readout: scaleReadout };
    }

    var toolbar = buildToolbar();
    readout = toolbar.readout;
    surface.appendChild(toolbar.element);

    for (var sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
      var built = buildScreen(sections[sectionIndex]);
      if (built) records.push(built);
    }

    surface.addEventListener('wheel', onSurfaceWheel, { passive: false });
    surface.addEventListener('pointerdown', onSurfacePointerDown);
    document.addEventListener('pointermove', onDocumentPointerMove, true);
    document.addEventListener('pointerup', endPan, true);
    document.addEventListener('pointercancel', endPan, true);
    document.addEventListener('keydown', onSpaceKeyDown, true);
    document.addEventListener('keyup', onSpaceKeyUp, true);
    // A window that loses focus never sends the keyup, and a hand tool left on
    // would keep the screens unclickable until the key came back.
    globalThis.addEventListener('blur', function () { setSpaceHeld(false); });
    globalThis.addEventListener('resize', scheduleMeasure);

    // Ready is a contract: the app waits for this class before it treats the
    // page as a canvas. The scale is stamped by the first apply below.
    document.documentElement.classList.add('cio-canvas-ready');
    applyTransform();
    fit();
    // The fit above ran before the stylesheet applied the grid and before any
    // frame had reported its height, so it is corrected as soon as either can
    // be known. Once the user zooms, pans or uses the toolbar, the view is
    // theirs and none of this runs again.
    if (injectedStylesheet) injectedStylesheet.addEventListener('load', fitIfUntouched);
    setTimeout(fitIfUntouched, 0);
  }

  // Every declared frame inside the root, in document order. A section nested
  // in a wrapper is still a frame, which is how the board reads the page too:
  // the two must agree, or a canvas shows a screen the board reports missing.
  function frameSections(root) {
    return root.querySelectorAll('section[data-cio-frame], section[data-cio-sketch]');
  }

  function boot() {
    // The whole build is defensive: a canvas page with unexpected markup must
    // never throw into the page it was meant to present.
    try {
      build();
    } catch {
      // A malformed canvas is left as the page wrote it.
    }
  }

  // The stylesheet goes in as early as the script runs, before the canvas is
  // built, so the frames never flash without their chrome. The element comes
  // back so the build can fit the canvas again once the styles have landed: the
  // grid has no columns until then, and a fit measured before it fits the wrong
  // page.
  var injectedStylesheet = null;
  try {
    injectedStylesheet = ensureStylesheet();
  } catch {
    // A page that blocks the link is still the page's business.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();`
}

/**
 * The canvas runtime stylesheet.
 *
 * Declared as a string for the same reason as the script, and served from its
 * own reserved path. The palette follows the system light or dark setting and
 * the frames read as design frames: a tabbed label bar, a soft border and
 * shadow, and a dotted surface behind the stage.
 */
export function screenCanvasRuntimeStyle(): string {
  return `:root {
  color-scheme: light dark;
  --cio-canvas-bg: #f2f0ea;
  --cio-canvas-dot: #d9d5c9;
  --cio-canvas-surface: #ffffff;
  --cio-canvas-bar: #f8f7f3;
  --cio-canvas-border: #e2e0d9;
  --cio-canvas-fg: #081825;
  --cio-canvas-muted: #5d6b76;
  --cio-canvas-dim: #8a949c;
  --cio-canvas-accent: #8a6d12;
  --cio-canvas-badge-bg: rgb(138 109 18 / 0.12);
  --cio-canvas-hover: #efece4;
  --cio-canvas-toolbar: rgb(255 255 255 / 0.92);
  --cio-canvas-shadow: 0 1px 2px rgb(8 24 37 / 0.06), 0 10px 30px rgb(8 24 37 / 0.1);
  --cio-canvas-radius: 10px;
  --cio-canvas-font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --cio-canvas-bg: #081825;
    --cio-canvas-dot: #17384f;
    --cio-canvas-surface: #0c2233;
    --cio-canvas-bar: #0f2a3e;
    --cio-canvas-border: #17384f;
    --cio-canvas-fg: #f2efe8;
    --cio-canvas-muted: #9fb0bd;
    --cio-canvas-dim: #6f8493;
    --cio-canvas-accent: #d4af37;
    --cio-canvas-badge-bg: rgb(212 175 55 / 0.16);
    --cio-canvas-hover: #112c40;
    --cio-canvas-toolbar: rgb(12 34 51 / 0.92);
    --cio-canvas-shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 12px 34px rgb(0 0 0 / 0.45);
  }
}
html.cio-canvas-ready,
html.cio-canvas-ready body {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
}
.cio-canvas-surface {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background-color: var(--cio-canvas-bg);
  background-image: radial-gradient(var(--cio-canvas-dot) 1px, transparent 1px);
  background-size: 24px 24px;
  cursor: grab;
  touch-action: none;
  overscroll-behavior: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-font-smoothing: antialiased;
  color: var(--cio-canvas-fg);
  font-family: var(--cio-canvas-font);
  font-size: 14px;
  line-height: 1.5;
}
.cio-canvas-surface.cio-canvas-space {
  cursor: grab;
}
/* The hand tool takes the pointer off the screens: a drag that starts on one
   pans the canvas, and the page inside it stops hovering and clicking for as
   long as space is held. */
.cio-canvas-surface.cio-canvas-space .cio-canvas-screen {
  pointer-events: none;
}
.cio-canvas-surface.cio-canvas-panning {
  cursor: grabbing;
}
.cio-canvas-stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  will-change: transform;
}
.cio-canvas-grid {
  display: grid;
  gap: 64px;
  align-items: start;
  justify-items: start;
  width: max-content;
  padding: 64px;
  box-sizing: border-box;
}
.cio-canvas-screen {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--cio-canvas-border);
  border-radius: var(--cio-canvas-radius);
  background: var(--cio-canvas-surface);
  box-shadow: var(--cio-canvas-shadow);
}
.cio-canvas-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 42px;
  padding: 8px 12px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--cio-canvas-border);
  background: var(--cio-canvas-bar);
}
.cio-canvas-bar-labels {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.cio-canvas-bar-title {
  overflow: hidden;
  color: var(--cio-canvas-fg);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cio-canvas-bar-caption {
  overflow: hidden;
  color: var(--cio-canvas-muted);
  font-size: 11px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cio-canvas-bar-action {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 3px 8px;
  border: 1px solid var(--cio-canvas-border);
  border-radius: 6px;
  color: var(--cio-canvas-muted);
  font-size: 11px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.cio-canvas-bar-action:hover {
  background: var(--cio-canvas-hover);
  color: var(--cio-canvas-fg);
}
.cio-canvas-bar-action:focus-visible {
  outline: 2px solid var(--cio-canvas-accent);
  outline-offset: 1px;
}
.cio-canvas-bar-badge {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--cio-canvas-badge-bg);
  color: var(--cio-canvas-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.cio-canvas-body {
  position: relative;
  background: var(--cio-canvas-surface);
}
.cio-canvas-body-frame {
  display: block;
  width: 100%;
  border: 0;
  background: var(--cio-canvas-surface);
}
.cio-canvas-body-sketch {
  padding: 24px;
  box-sizing: border-box;
}
.cio-canvas-toolbar {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px;
  box-sizing: border-box;
  border: 1px solid var(--cio-canvas-border);
  border-radius: 10px;
  background: var(--cio-canvas-toolbar);
  box-shadow: var(--cio-canvas-shadow);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
.cio-canvas-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--cio-canvas-muted);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.cio-canvas-tool:hover {
  background: var(--cio-canvas-hover);
  color: var(--cio-canvas-fg);
}
.cio-canvas-tool:focus-visible {
  outline: 2px solid var(--cio-canvas-accent);
  outline-offset: -1px;
}
.cio-canvas-tool svg {
  width: 15px;
  height: 15px;
}
.cio-canvas-tool-reset {
  min-width: auto;
  padding: 0 8px;
  font-variant-numeric: tabular-nums;
}
.cio-canvas-readout {
  min-width: 44px;
  color: var(--cio-canvas-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  -webkit-user-select: none;
  user-select: none;
}
@media (prefers-reduced-motion: reduce) {
  .cio-canvas-bar-action,
  .cio-canvas-tool {
    transition: none;
  }
}
`
}
