import { describe, expect, it } from 'vitest'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '$shared/types'
import { ASSISTANT_ICON_FALLBACK_COLOR } from '$lib/assistant-icons'
import { threadContainerMark } from '$lib/thread-container-mark'

describe('threadContainerMark', () => {
  it('wears the project icon of the project a thread lives in', () => {
    expect(
      threadContainerMark(
        { projectId: 'project-1' },
        { projectIconUrl: 'data:image/svg+xml;base64,AAAA' }
      )
    ).toEqual({ kind: 'image', url: 'data:image/svg+xml;base64,AAAA' })
  })

  it('falls back to a conversation mark for a project that resolved no icon', () => {
    expect(threadContainerMark({ projectId: 'project-1' })).toEqual({ kind: 'chats' })
  })

  it('gives a chat the conversation mark, never a project icon', () => {
    expect(
      threadContainerMark(
        { projectId: INBOX_PROJECT_ID },
        { projectIconUrl: 'data:image/svg+xml;base64,AAAA' }
      )
    ).toEqual({ kind: 'chats' })
  })

  it('wears the assistant icon of the assistant an assistant thread belongs to', () => {
    expect(
      threadContainerMark(
        { projectId: ASSISTANT_SPACE_ID },
        {
          assistant: { color: '#123456' },
          assistantIconUrl: 'data:image/svg+xml;base64,BBBB'
        }
      )
    ).toEqual({ kind: 'image', url: 'data:image/svg+xml;base64,BBBB' })
  })

  it('draws the assistant default mark in the assistant accent colour when it has no icon', () => {
    expect(
      threadContainerMark({ projectId: ASSISTANT_SPACE_ID }, { assistant: { color: '#123456' } })
    ).toEqual({ kind: 'assistant', color: '#123456' })
  })

  it('falls back to the assistant default mark when the assistant is unresolved', () => {
    expect(
      threadContainerMark(
        { projectId: ASSISTANT_SPACE_ID },
        { projectIconUrl: 'data:image/svg+xml;base64,AAAA' }
      )
    ).toEqual({ kind: 'assistant', color: ASSISTANT_ICON_FALLBACK_COLOR })
  })
})
