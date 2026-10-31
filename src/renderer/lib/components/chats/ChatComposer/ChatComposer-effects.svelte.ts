import { trackEscapeMenu } from '$lib/overlay-close.svelte'
import { onDestroy, onMount } from 'svelte'
import { getInlineFileTypeIconSvg, getInlineFolderTypeIconSvg } from '../../files/file-type-icons'
import { installComposerDropListeners } from '../chat-composer-drop'
import { trackMenuCloseFocus } from '../chat-composer-menu-focus.svelte'
import { projectReferenceToken } from '../chat-composer-attachments'
import { modelRuntime } from '$lib/stores/model-runtime.svelte'
import { ovens } from '$lib/stores/ovens.svelte'
import type { ChatComposer } from './ChatComposer-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ChatComposer board. */
export class ChatComposerEffects extends BoardUnit<ChatComposer> {
  constructor(root: ChatComposer) {
    super(root)
  }
  /**
   * The work the surface used to do as it set itself up: effects, the
   * subscriptions it opened and the first load it kicked off. It runs from
   * the board's constructor, which the component calls during its own setup,
   * so every effect here is owned by the component.
   */
  init(): void {
    $effect(() => {
      const ovenId = this.root.handleDropData.targetOvenId
      if (!ovenId || ovenId === 'local') return
      void ovens.ensure()
      void ovens.ensureInventory(ovenId)
    })

    $effect(() => {
      const references = this.root.submit.projectReferences.map((reference) => ({ ...reference }))
      let current = true
      void Promise.all(
        references.map(
          async (reference) =>
            [
              projectReferenceToken(reference),
              reference.kind === 'directory'
                ? await getInlineFolderTypeIconSvg(reference.name)
                : await getInlineFileTypeIconSvg(reference.path)
            ] as const
        )
      ).then((entries) => {
        if (current)
          this.root.captureComposerRoot.projectReferenceIcons = Object.fromEntries(entries)
      })
      return () => {
        current = false
      }
    })

    // Opening the picker re-probes the Oven's harnesses, so a harness installed on
    // the Oven since the last check shows up without leaving the thread.
    $effect(() => {
      if (!this.root.handleDropData.modelMenuOpen) return
      const ovenId = this.root.handleDropData.targetOvenId
      if (!ovenId || ovenId === 'local') return
      void ovens.ensureInventory(ovenId, true)
    })

    trackEscapeMenu(
      () => this.root.handleDropData.plusMenuOpen,
      () => {
        this.root.handleDropData.plusMenuOpen = false
      }
    )

    trackEscapeMenu(
      () => this.root.handleDropData.modelMenuOpen,
      () => {
        this.root.handleDropData.modelMenuOpen = false
      }
    )

    trackEscapeMenu(
      () => this.root.handleDropData.inferenceMenuOpen,
      () => {
        this.root.handleDropData.inferenceMenuOpen = false
      }
    )

    trackEscapeMenu(
      () => this.root.handleDropData.permissionMenuOpen,
      () => {
        this.root.handleDropData.permissionMenuOpen = false
      }
    )

    trackEscapeMenu(
      () => this.root.handleDropData.thinkingMenuOpen,
      () => {
        this.root.handleDropData.thinkingMenuOpen = false
      }
    )

    trackEscapeMenu(
      () => this.root.handleDropData.accountMenuOpen,
      () => {
        this.root.handleDropData.accountMenuOpen = false
      }
    )

    trackEscapeMenu(
      () => this.root.handleDropData.startAfterPickerOpen,
      () => {
        this.root.handleDropData.startAfterPickerOpen = false
      }
    )

    trackEscapeMenu(
      () => this.root.captureComposerRoot.selectionPopoverOpen,
      this.root.captureComposerRoot.closeSelectionPopover
    )

    trackEscapeMenu(
      () => this.root.captureComposerRoot.startAfterPopoverOpen,
      this.root.captureComposerRoot.closeStartAfterPopover
    )

    // Focus restoration on close for every menu/overlay that steals focus from
    // the editor: each returns the caret to its last published position rather
    // than the end, so mid-sentence editing stays seamless.
    trackMenuCloseFocus(
      () => this.root.handleDropData.modelMenuOpen,
      this.root.submit.focusComposerAtSavedCaret
    )

    trackMenuCloseFocus(
      () => this.root.handleDropData.thinkingMenuOpen,
      this.root.submit.focusComposerAtSavedCaret
    )

    trackMenuCloseFocus(
      () => this.root.handleDropData.accountMenuOpen,
      this.root.submit.focusComposerAtSavedCaret
    )

    trackMenuCloseFocus(
      () => this.root.handleDropData.permissionMenuOpen,
      this.root.submit.focusComposerAtSavedCaret
    )

    trackMenuCloseFocus(
      () => this.root.handleDropData.inferenceMenuOpen,
      this.root.submit.focusComposerAtSavedCaret
    )

    $effect(() => {
      modelRuntime.ensure(this.root.handleDropData.modelRuntimeSelection)
    })

    // Cancel pending stop when the agent stops working on its own.
    $effect(() => {
      if (this.root.props.working) return
      this.root.submit.cancelStop()
    })

    onMount(() => {
      void this.root.handleDropData.preview.loadAll(this.root.submit.attachments)
    })

    onDestroy(() => {
      this.root.submit.mentions.dispose()
      clearTimeout(this.root.captureComposerRoot.selectionPopoverTimer)
      clearTimeout(this.root.captureComposerRoot.startAfterPopoverTimer)
      this.root.handleDropData.preview.revokeAll()
    })

    // Register the document-level drag listeners once on mount and gate each
    // handler on the current mode flags. The previous $effect re-subscribed on
    // every change of readOnlyMode/allowAttachments; with the handlers gating on
    // those values at event time the behavior is identical while keeping the
    // listener lifecycle (and the isDragging mutations) out of a reactive effect.
    onMount(() =>
      installComposerDropListeners({
        getReadOnlyMode: () => this.root.props.readOnlyMode,
        getAllowAttachments: () => this.root.props.allowAttachments,
        getSelectedHarnessLacksAttachments: () =>
          this.root.handleDropData.selectedHarnessLacksAttachments,
        getComposerRoot: () => this.root.captureComposerRoot.composerRoot,
        getDropAnchorProbe: () => this.root.handleDropAnchorChange.dropAnchorProbe,
        setDragging: (dragging) => (this.root.clearDropState.isDragging = dragging),
        setDropRegion: (region) => (this.root.clearDropState.dropRegion = region),
        setAttachmentBlockedNotice: (blocked) =>
          (this.root.handleDropData.attachmentBlockedNotice = blocked),
        handleDropData: this.root.handleDropData.handleDropData
      })
    )
  }
}
