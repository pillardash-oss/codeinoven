import './app.css'
import { mount } from 'svelte'
import BrowserPermissionPrompt from '$lib/components/browser/BrowserPermissionPrompt.svelte'

/**
 * The entry for the browser permission popup.
 *
 * It loads the app's own stylesheet, because the prompt is drawn as one of the
 * app's own surfaces: one card, in the tokens and fonts the toaster's cards are
 * drawn with, instead of the hand-written palette the popup used to carry. It
 * mounts one component and runs nothing else of the app, which is what keeps the
 * window cheap enough to open on any permission request.
 *
 * The theme arrives as a query parameter so the first paint is already in the
 * right palette; the component refines it from the live app config, which is the
 * theme the user actually chose.
 */

document.documentElement.classList.toggle(
  'dark',
  new URLSearchParams(window.location.search).get('theme') === 'dark'
)

const target = document.getElementById('permission-prompt')
if (target) mount(BrowserPermissionPrompt, { target })
