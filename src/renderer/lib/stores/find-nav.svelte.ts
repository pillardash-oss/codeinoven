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
}

export const findNavState = new FindNavState()
