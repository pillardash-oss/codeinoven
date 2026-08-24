/// <reference types="vite/client" />

import './app.css'
import type { NativeSwitcherPayload, NativeSwitcherThread } from '$shared/ipc-contract'

interface SwitcherBridge {
  getData: () => Promise<NativeSwitcherPayload | null>
  onData: (callback: (payload: NativeSwitcherPayload) => void) => () => void
  select: (threadId: string) => void
  highlight: (threadId: string) => void
  close: () => void
}

declare global {
  interface Window {
    switcherBridge: SwitcherBridge
  }
}

/** Desktop Ctrl+Tab switcher rendered inside the native overlay WebContentsView.
 *  It owns its own keyboard/row UI locally (no per-keystroke IPC) and reports
 *  only the meaningful transitions back to main → the application renderer,
 *  which performs the actual thread switch, message preload, and composer
 *  focus. */
class NativeSwitcherController {
  private app: HTMLElement
  private container: HTMLElement
  private threads: NativeSwitcherThread[] = []
  private highlightedIndex = 0
  private pointerAtOpen = { x: 0, y: 0 }
  private lastPointer = { x: 0, y: 0 }
  private open = false

  constructor() {
    const app = document.getElementById('app')
    if (!app) throw new Error('Native switcher mount point missing')
    this.app = app
    this.container = document.createElement('div')
    app.append(this.container)

    window.addEventListener('pointermove', (event) => {
      this.lastPointer = { x: event.clientX, y: event.clientY }
    })
    window.addEventListener('keydown', (event) => this.onKeyDown(event))
    window.addEventListener('keyup', (event) => this.onKeyUp(event))
    window.addEventListener('blur', () => this.dismiss())

    window.switcherBridge.onData((payload) => this.show(payload))
    void window.switcherBridge.getData().then((payload) => {
      if (payload) this.show(payload)
    })
  }

  private show(payload: NativeSwitcherPayload): void {
    this.threads = payload.threads ?? []
    this.pointerAtOpen = this.lastPointer

    const theme = payload.theme === 'dark' ? 'dark' : 'light'
    document.documentElement.classList.toggle('dark', theme === 'dark')

    const highlighted = payload.highlightedThreadId ?? this.threads[0]?.id ?? null
    this.highlightedIndex = Math.max(
      0,
      this.threads.findIndex((thread) => thread.id === highlighted)
    )

    this.open = true
    this.render()
    this.notifyHighlight()
  }

  private render(): void {
    this.container.replaceChildren()
    this.container.className = 'fixed inset-0 z-50 bg-app/50'

    const dialog = document.createElement('div')
    dialog.className =
      'fixed left-1/2 top-[18%] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-xl'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-label', 'Switch thread')

    const header = document.createElement('header')
    header.className = 'border-b border-border px-4 py-3'
    const title = document.createElement('p')
    title.className = 'text-sm font-semibold text-foreground'
    title.textContent = 'Switch thread'
    const hint = document.createElement('p')
    hint.className = 'mt-0.5 text-[11px] text-dimmed'
    hint.textContent = 'Release Control to open the highlighted thread'
    header.append(title, hint)
    dialog.append(header)

    const list = document.createElement('div')
    list.className = 'max-h-[min(28rem,65vh)] overflow-y-auto p-1.5'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', 'Recent threads')

    for (let index = 0; index < this.threads.length; index += 1) {
      const thread = this.threads[index]
      const row = document.createElement('button')
      row.type = 'button'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(index === this.highlightedIndex))
      row.dataset.threadIndex = String(index)
      row.className = [
        'flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 text-left outline-none transition-colors',
        index === this.highlightedIndex
          ? 'bg-elevated focus-visible:ring-2 focus-visible:ring-primary'
          : 'hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary'
      ].join(' ')
      row.addEventListener('pointerenter', () => {
        if (this.pointerMovedSinceOpen()) this.setHighlight(index)
      })
      row.addEventListener('click', () => this.selectThread(thread))
      row.addEventListener('focus', () => this.setHighlight(index))

      const iconBox = document.createElement('span')
      iconBox.className = 'grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full'
      if (thread.icon) {
        const img = document.createElement('img')
        img.src = thread.icon
        img.alt = ''
        img.className = 'h-6 w-6 rounded-full object-cover'
        img.addEventListener('error', () => {
          img.remove()
          iconBox.textContent = thread.title.charAt(0).toUpperCase()
          iconBox.className =
            'grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-elevated text-[10px] font-semibold text-dimmed'
        })
        iconBox.append(img)
      } else {
        iconBox.textContent = thread.title.charAt(0).toUpperCase()
        iconBox.className =
          'grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-elevated text-[10px] font-semibold text-dimmed'
      }

      const label = document.createElement('span')
      label.className = 'min-w-0 truncate text-sm text-foreground'
      label.textContent = thread.title

      row.append(iconBox, label)
      list.append(row)
    }
    dialog.append(list)

    const footer = document.createElement('footer')
    footer.className =
      'flex h-8 items-center justify-between border-t border-border bg-raised px-3 text-[10px] text-dimmed'
    const count = document.createElement('span')
    count.className = 'tabular-nums'
    count.textContent = `${this.threads.length} recent threads`
    const shortcut = document.createElement('span')
    shortcut.textContent = 'Ctrl+Tab next · Shift+Ctrl+Tab previous'
    footer.append(count, shortcut)
    dialog.append(footer)

    this.container.append(dialog)

    this.focusHighlightedRow()
  }

  private pointerMovedSinceOpen(): boolean {
    const dx = this.lastPointer.x - this.pointerAtOpen.x
    const dy = this.lastPointer.y - this.pointerAtOpen.y
    return dx * dx + dy * dy > 16
  }

  private focusHighlightedRow(): void {
    this.container
      .querySelector<HTMLElement>(`[data-thread-index="${this.highlightedIndex}"]`)
      ?.focus()
  }

  private setHighlight(index: number): void {
    if (!this.open) return
    this.highlightedIndex = (index + this.threads.length) % this.threads.length
    const rows = this.container.querySelectorAll<HTMLElement>('[role="option"]')
    for (let i = 0; i < rows.length; i += 1) {
      rows[i].setAttribute('aria-selected', String(i === this.highlightedIndex))
      rows[i].classList.toggle('bg-elevated', i === this.highlightedIndex)
      rows[i].classList.toggle('hover:bg-elevated', i !== this.highlightedIndex)
    }
    this.notifyHighlight()
  }

  private notifyHighlight(): void {
    const thread = this.threads[this.highlightedIndex]
    if (thread) window.switcherBridge.highlight(thread.id)
  }

  private cycle(direction: 1 | -1): void {
    if (!this.open || this.threads.length === 0) return
    this.setHighlight(
      (this.highlightedIndex + direction + this.threads.length) % this.threads.length
    )
    this.focusHighlightedRow()
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && event.ctrlKey) {
      event.preventDefault()
      event.stopPropagation()
      this.cycle(event.shiftKey ? -1 : 1)
      return
    }
    if (this.open && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      this.dismiss()
    }
  }

  private onKeyUp(event: KeyboardEvent): void {
    if (!this.open || event.key !== 'Control') return
    event.preventDefault()
    event.stopPropagation()
    const thread = this.threads[this.highlightedIndex]
    if (thread) this.selectThread(thread)
  }

  private selectThread(thread: NativeSwitcherThread): void {
    if (!this.open) return
    this.open = false
    window.switcherBridge.select(thread.id)
  }

  private dismiss(): void {
    if (!this.open) return
    this.open = false
    window.switcherBridge.close()
  }
}

new NativeSwitcherController()
