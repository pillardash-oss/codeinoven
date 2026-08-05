class FindNavState {
  editorFindOpen = $state(false)
  editorFindQuery = $state('')
  editorFindActiveIndex = $state(0)
  editorFindMatches = $state(0)
  editorFindFocusTrigger = $state(0)
  focusFileTreeFilter = $state(0)
  conversationFindOpen = $state(false)
  conversationFindFocusTrigger = $state(0)

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
}

export const findNavState = new FindNavState()
