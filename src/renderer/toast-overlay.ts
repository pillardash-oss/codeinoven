import './app.css'
import { mount } from 'svelte'
import ToastOverlaySurface from '$lib/components/ui/ToastOverlaySurface.svelte'

/**
 * The entry for the toast overlay window.
 *
 * It loads the app's own stylesheet, because the cards drawn here have to be the
 * cards the app window draws, down to the tokens and the font, and it mounts one
 * component: the toaster that renders the stack the app renderer publishes.
 * Nothing else of the app runs in this window, which is what keeps a second
 * renderer cheap enough to open for the duration of a toast.
 *
 * The theme arrives as a query parameter so the first paint is already in the
 * right palette; the stack carries it from then on.
 */

document.documentElement.classList.toggle(
  'dark',
  new URLSearchParams(window.location.search).get('theme') === 'dark'
)

const target = document.getElementById('toast-overlay')
if (target) mount(ToastOverlaySurface, { target })
