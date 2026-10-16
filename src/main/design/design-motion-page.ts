import { authoredMotionCss, type AuthoredMotion } from '../../lib/design/motion-policy'

/** Fixed commands only; the capability never accepts arbitrary page JavaScript. */
export function designMotionPageScript(input: {
  targetId?: string
  motion?: AuthoredMotion
  sampleMs?: number
}): string {
  const css =
    input.targetId && input.motion ? authoredMotionCss(input.targetId, input.motion) : null
  return `(async () => {
    const input = ${JSON.stringify({ ...input, css })};
    if (input.css) {
      const targets = document.querySelectorAll('#' + CSS.escape(input.targetId));
      if (targets.length !== 1) throw new Error('Motion target must match exactly one element');
      let style = document.querySelector('style[data-cio-motion-preview]');
      if (!style) { style = document.createElement('style'); style.setAttribute('data-cio-motion-preview',''); document.head.append(style); }
      style.textContent = input.css.replaceAll('cio-motion-' + input.targetId, 'cio-motion-' + input.targetId + '-preview-' + Math.round(performance.now()*1000));
      return { previewOnly:true, targetId:input.targetId, reducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches };
    }
    const samples = [];
    const collect = () => {
      const animations = document.getAnimations();
      samples.push({ at:performance.now(), total:animations.length, truncated:animations.length>100,
        animations:animations.slice(0,100).map(animation => {
          const effect = animation.effect;
          const timing = effect ? effect.getComputedTiming() : {};
          const node = effect && effect.target;
          const rect = node && node.getBoundingClientRect ? node.getBoundingClientRect() : null;
          const properties = effect && effect.getKeyframes ? [...new Set(effect.getKeyframes().slice(0,64).flatMap(frame=>Object.keys(frame).filter(key=>!['offset','computedOffset','easing','composite'].includes(key))))] : [];
          return { target:node ? (node.id ? '#'+node.id : node.tagName) : null, state:animation.playState, duration:Number.isFinite(timing.duration)?timing.duration:null, infinite:timing.iterations===Infinity, properties,
            visible:rect ? rect.width>0 && rect.height>0 && rect.bottom>0 && rect.right>0 && rect.top<innerHeight && rect.left<innerWidth : false };
        }) });
    };
    collect();
    await new Promise(resolve=>setTimeout(resolve,input.sampleMs));
    collect();
    return { url:location.href, reducedMotion:matchMedia('(prefers-reduced-motion:reduce)').matches, samples,
      limitations:['Samples describe Web Animations API effects at two times; they do not measure FPS, canvas loops or all timer-driven motion.','Reduced motion reports the current OS setting; exercise both preferences separately.'] };
  })()`
}
