import { describe, expect, it } from 'vitest'
import {
  threadContextPrompt,
  threadReferenceAttachment,
  uniqueThreadContextReferences
} from '../../../src/renderer/lib/thread-context'

/**
 * A conversation attached to a prompt rides two ways: a hidden sentence tells the
 * agent which thread it may read, and a chip on the message names it to the
 * reader. The chip is the only record left once the composer hands the
 * attachment over with the send, so it has to carry the thread's own identity.
 */
describe('threadReferenceAttachment', () => {
  it('keeps the thread identity the chip opens', () => {
    const attachment = threadReferenceAttachment({
      projectId: 'project-1',
      threadId: 'thread-1',
      title: 'Why the build broke'
    })
    expect(attachment).toMatchObject({
      kind: 'thread',
      label: 'Why the build broke',
      threadId: 'thread-1',
      projectId: 'project-1'
    })
    expect(attachment.id).toBe('thread-1')
  })

  it('stays apart from the passages a prompt quotes', () => {
    const attachment = threadReferenceAttachment({
      projectId: 'project-1',
      threadId: 'thread-1',
      title: 'Background'
    })
    expect(attachment).not.toHaveProperty('comment')
    expect(
      threadContextPrompt([{ projectId: 'project-1', threadId: 'thread-1', title: 'x' }])
    ).toContain('thread-1')
  })

  it('attaches one thread once', () => {
    const unique = uniqueThreadContextReferences([
      { projectId: 'p', threadId: 't1', title: 'One' },
      { projectId: 'p', threadId: 't1', title: 'One again' },
      { projectId: 'p', threadId: 't2', title: 'Two' }
    ])
    expect(unique.map((reference) => reference.threadId)).toEqual(['t1', 't2'])
  })
})
