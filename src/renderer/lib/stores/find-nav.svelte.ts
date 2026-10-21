class FindNavState {
  editorFindOpen = $state(false)
  editorFindQuery = $state('')
  editorFindActiveIndex = $state(0)
  editorFindMatches = $state(0)
  editorFindFocusTrigger = $state(0)
  focusFileTreeFilter = $state(0)
  conversationFindOpen = $state(false)
  conversationFindFocusTrigger = $state(0)
  gitFindOpen = $state(false)
  gitFindFocusTrigger = $state(0)
  studioFindOpen = $state(false)
  studioFindFocusTrigger = $state(0)
  /** The file reader's rendered views (annotate, document preview, diff). Their
   *  text only exists as DOM, so the source editor's own find cannot see it and
   *  the reader searches the visible document instead. */
  fileDocumentFindOpen = $state(false)
  fileDocumentFindFocusTrigger = $state(0)
  stickyNotesFindOpen = $state(false)
  stickyNotesFindFocusTrigger = $state(0)
  threadNotesFindOpen = $state(false)
  threadNotesFindFocusTrigger = $state(0)

  openEditorFind(): void {
    if (!this.editorFindOpen) {
      this.editorFindQuery = ''
      this.editorFindActiveIndex = 0
      this.editorFindMatches = 0
    }
    this.editorFindOpen = true
    this.editorFindFocusTrigger++
  }

  closeEditorFind(): void {
    this.editorFindOpen = false
    this.editorFindQuery = ''
    this.editorFindActiveIndex = 0
    this.editorFindMatches = 0
  }

  openConversationFind(): void {
    this.conversationFindOpen = true
    this.conversationFindFocusTrigger++
  }

  closeConversationFind(): void {
    this.conversationFindOpen = false
  }

  openGitFind(): void {
    this.gitFindOpen = true
    this.gitFindFocusTrigger++
  }

  closeGitFind(): void {
    this.gitFindOpen = false
  }

  openStudioFind(): void {
    this.studioFindOpen = true
    this.studioFindFocusTrigger++
  }

  closeStudioFind(): void {
    this.studioFindOpen = false
  }

  openFileDocumentFind(): void {
    // Only one find covers the reader at a time: a query in the source editor
    // and a query in the rendered document would each claim every match.
    this.closeEditorFind()
    this.fileDocumentFindOpen = true
    this.fileDocumentFindFocusTrigger++
  }

  closeFileDocumentFind(): void {
    this.fileDocumentFindOpen = false
  }

  openStickyNotesFind(): void {
    this.stickyNotesFindOpen = true
    this.stickyNotesFindFocusTrigger++
  }

  closeStickyNotesFind(): void {
    this.stickyNotesFindOpen = false
  }

  openThreadNotesFind(): void {
    this.threadNotesFindOpen = true
    this.threadNotesFindFocusTrigger++
  }

  closeThreadNotesFind(): void {
    this.threadNotesFindOpen = false
  }
}

export const findNavState = new FindNavState()
