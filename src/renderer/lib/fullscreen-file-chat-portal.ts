import type { Attachment } from 'svelte/attachments'
import { AppPanelPortal } from './app-panel-portal'

// Move the existing sidebar into the project file reader. Its callbacks,
// controller, composer, and tab strip retain their original owners.
const portal = new AppPanelPortal()

export const fullscreenFileChatSlot: Attachment<HTMLElement> = (node) => {
  portal.registerSlot(node)
  return () => portal.unregisterSlot(node)
}

export const fullscreenFileChatHost: Attachment<HTMLElement> = (node) => {
  const fallback = node.parentElement
  if (!fallback) return
  portal.registerHost({ host: node, fallback })
  return () => {
    fallback.appendChild(node)
    portal.unregisterHost(node)
  }
}

// Remember which existing tab to restore when this reader is opened again.
export const fullscreenFileChatTabs = new Map<string, string>()
