/** Small opt-in controls for an authored page. Values never reload its document. */
export function designTweaksRuntimeScript(): string {
  return `(() => {
    'use strict';
    if (document.querySelector('[data-cio-tweaks-panel]')) return;
    const manifest = document.querySelector('script[type="application/json"][data-cio-tweaks]');
    if (!manifest || manifest.textContent.length > 16000) return;
    let parameters;
    try { parameters = JSON.parse(manifest.textContent); } catch { return; }
    if (!Array.isArray(parameters) || parameters.length > 12) return;
    const panel = document.createElement('aside');
    panel.setAttribute('data-cio-tweaks-panel', ''); panel.setAttribute('aria-label', 'Design controls');
    panel.style.cssText = 'position:fixed;right:1rem;bottom:1rem;z-index:2147483640;max-width:22rem;max-height:40vh;overflow:auto;padding:.75rem;border:1px solid var(--color-border,GrayText);border-radius:.5rem;background:var(--color-surface,Canvas);color:var(--color-foreground,CanvasText);font:inherit;box-shadow:0 .25rem 1rem color-mix(in srgb,var(--color-border,GrayText) 30%,transparent)';
    const title = document.createElement('summary'); title.textContent = 'Design controls';
    const details = document.createElement('details'); details.append(title); details.open = true;
    const values = Object.create(null);
    for (const parameter of parameters) {
      if (!parameter || typeof parameter.id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(parameter.id) || typeof parameter.label !== 'string') continue;
      if (!['color','range','select','text'].includes(parameter.type)) continue;
      if (parameter.variable && !/^--[a-zA-Z][a-zA-Z0-9_-]{0,60}$/.test(parameter.variable)) continue;
      const label = document.createElement('label'); label.style.cssText = 'display:flex;gap:.75rem;align-items:center;margin-top:.5rem;font-size:.8125rem';
      const caption = document.createElement('span'); caption.textContent = parameter.label.slice(0,80); label.append(caption);
      const input = document.createElement(parameter.type === 'select' ? 'select' : 'input');
      if (parameter.type === 'select') {
        if (!Array.isArray(parameter.options) || parameter.options.length > 20) continue;
        for (const choice of parameter.options) {
          if (typeof choice !== 'string' || choice.length > 100) continue;
          const option = document.createElement('option'); option.value = choice; option.textContent = choice; input.append(option);
        }
      } else input.type = parameter.type;
      if (parameter.type === 'range') {
        if (![parameter.min,parameter.max].every(Number.isFinite) || parameter.min >= parameter.max) continue;
        input.min = String(parameter.min); input.max = String(parameter.max);
        if (Number.isFinite(parameter.step) && parameter.step > 0) input.step = String(parameter.step);
      }
      input.value = String(parameter.value ?? '').slice(0,200); input.style.cssText = 'max-width:10rem;font:inherit';
      const apply = () => {
        values[parameter.id] = input.value;
        if (parameter.variable) document.documentElement.style.setProperty(parameter.variable, input.value + (typeof parameter.unit === 'string' && /^(rem|em|px|%)$/.test(parameter.unit) ? parameter.unit : ''));
        document.dispatchEvent(new CustomEvent('cio:tweaks', { detail: { ...values } }));
      };
      input.addEventListener('input',apply); label.append(input); details.append(label); apply();
    }
    if (details.childElementCount > 1) { panel.append(details); document.body.append(panel); }
  })();`
}
