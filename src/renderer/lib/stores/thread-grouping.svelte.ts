export type ThreadGroup = 'Attention' | 'Unread' | 'Errors' | 'Spec' | 'Working' | 'Done'

class ThreadGroupingState {
  enabled = $state(false)
  folded = $state<Record<ThreadGroup, boolean>>({
    Attention: false,
    Unread: false,
    Errors: false,
    Spec: false,
    Working: false,
    Done: false
  })
}

export const threadGroupingState = new ThreadGroupingState()
