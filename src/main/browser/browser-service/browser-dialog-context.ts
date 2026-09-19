/**
 * The injected alert/confirm wrapper for embedded browser pages. Chromium
 * renders page dialogs as native windows parented to the app window and
 * carries no context about which CodeInOven thread owns the page, so every
 * loaded document gets this shim.
 */

/** Build the injected wrapper that prefixes page alert/confirm messages with
 *  the owning thread's context line. Escaping goes through `JSON.stringify`,
 *  so any project or thread name is embedded safely as a JS string literal. */
export function dialogContextScript(label: string): string {
  return `(() => {
  const label = ${JSON.stringify(label)};
  const win = window;
  if (win.__cioDialogOriginals === undefined) win.__cioDialogOriginals = {};
  const originals = win.__cioDialogOriginals;
  for (const [name, kind] of [['alert', 'Alert'], ['confirm', 'Confirm']]) {
    if (typeof originals[name] !== 'function') {
      const current = win[name];
      if (typeof current !== 'function') continue;
      originals[name] = current.bind(win);
    }
    const original = originals[name];
    win[name] = function (message) {
      const text = message == null ? '' : String(message);
      return original(label + ' ' + kind + '\\n\\n' + text);
    };
  }
})()`
}
