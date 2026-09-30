import './app.css'
import { mount } from 'svelte'
import { invoke } from '$lib/ipc.svelte'
import { applyAppTypography } from '$lib/app-typography'
import BrowserOverlaySurface from '$lib/components/ui/BrowserOverlaySurface.svelte'

/**
 * The entry for the browser overlay window.
 *
 * It loads the app's own stylesheet, because what is drawn here has to be what
 * the app window draws, down to the tokens and the font, and it mounts one
 * component: the surfaces that render the content the app renderer publishes
 * (the toast stack, and the browser's floating tab strip). Nothing else of the
 * app runs in this window, which is what keeps a second renderer cheap enough to
 * open for the duration of a toast or a hover.
 *
 * The theme arrives as a query parameter so the first paint is already in the
 * right palette; the content carries it from then on. The fonts are the app's own
 * appearance setting and are not part of that content, so they are read once
 * here: without them the same card draws at the stylesheet's default size in this
 * window and at the user's chosen one in the app window, and the handover
 * visibly resizes its text.
 */

document.documentElement.classList.toggle(
  'dark',
  new URLSearchParams(window.location.search).get('theme') === 'dark'
)

void invoke('config:get')
  .then((config) => applyAppTypography(document.documentElement, config))
  .catch(() => {})

const target = document.getElementById('browser-overlay')
if (target) mount(BrowserOverlaySurface, { target })
