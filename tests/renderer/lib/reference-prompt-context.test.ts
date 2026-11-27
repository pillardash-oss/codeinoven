import { describe, expect, it } from 'vitest'
import { markAttachmentFilenames } from '$lib/annotation-composite'
import { attachedReferenceContext, referencePromptContext } from '$lib/reference-prompt-context'
import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'

function reference(overrides: Partial<ResponseReferenceAnchor>): ResponseReferenceAnchor {
  return { id: 'reference-1', label: 'Selection 1', text: 'quoted text', ...overrides }
}

describe('referencePromptContext', () => {
  it('answers nothing when the message carries no references', () => {
    expect(referencePromptContext([])).toBeUndefined()
  })

  it('describes a quoted response excerpt with its comment', () => {
    const context = referencePromptContext([
      reference({ text: 'the quoted passage', comment: 'make this shorter' })
    ])

    expect(context).toContain('<selection>\nthe quoted passage\n</selection>')
    expect(context).toContain('User comment: make this shorter')
    expect(context).toContain('Combine all references and the typed message into one work list')
  })

  it('names each reference kind with the tag the agent reads', () => {
    const context = referencePromptContext([
      reference({ id: 'design', label: 'Button', text: 'design text', kind: 'design' }),
      reference({ id: 'file', label: 'docs/spec.md', text: 'annotated passage', kind: 'file' }),
      reference({ id: 'video', label: 'Intro', text: 'at 00:12', kind: 'video' }),
      reference({ id: 'image', label: 'Mark 1', text: 'round logo', kind: 'image' })
    ])

    expect(context).toContain('[Button]\n<element>\ndesign text\n</element>')
    expect(context).toContain('[docs/spec.md]\n<file>\nannotated passage\n</file>')
    expect(context).toContain('[Intro]\n<video>\nat 00:12\n</video>')
    expect(context).toContain('[Mark 1]\n<image>\nround logo\n</image>')
  })

  it('leaves an attached conversation out of the excerpt blocks', () => {
    expect(
      referencePromptContext([
        reference({ id: 'thread-1', label: 'Design notes', text: 'thread-1', kind: 'thread' })
      ])
    ).toBeUndefined()
  })
})

describe('attachedReferenceContext', () => {
  it('tells the agent which conversation it may look up', () => {
    const context = attachedReferenceContext(
      [
        reference({
          id: 'thread-1',
          label: 'Design notes',
          text: 'thread-1',
          kind: 'thread',
          threadId: 'thread-1',
          projectId: 'project-9'
        }),
        reference({ id: 'selection', text: 'the quoted passage' })
      ],
      'current-project'
    )

    expect(context).toContain(
      'You may lookup this thread: thread-1 if you need some context as to the sent message'
    )
    expect(context).toContain('<selection>\nthe quoted passage\n</selection>')
    // A conversation travels by identity only, never as an excerpt block.
    expect(context).not.toContain('<selection>\nthread-1\n</selection>')
  })

  it('answers nothing when the message carries no references at all', () => {
    expect(attachedReferenceContext([], 'current-project')).toBeUndefined()
  })
})

describe('markAttachmentFilenames', () => {
  it('names the picture a still mark is composed onto', () => {
    expect(
      markAttachmentFilenames([
        reference({
          kind: 'image',
          mediaUrl: 'file:///projects/app/out/logo.png',
          points: [{ x: 0.5, y: 0.5 }]
        })
      ])
    ).toEqual(['logo-annotated.png'])
  })

  it('names the frame a video note marks, keeping marks on separate moments apart', () => {
    expect(
      markAttachmentFilenames([
        reference({
          kind: 'image',
          mediaUrl: 'file:///projects/app/out/intro.mp4',
          markSeconds: 65,
          points: [{ x: 0.1, y: 0.1 }]
        }),
        reference({
          id: 'reference-2',
          kind: 'image',
          mediaUrl: 'file:///projects/app/out/intro.mp4',
          markSeconds: 12,
          points: [{ x: 0.2, y: 0.2 }]
        })
      ])
    ).toEqual(['intro-1-05.000-annotated.png', 'intro-0-12.000-annotated.png'])
  })

  it('names nothing for references that carry no picture', () => {
    expect(markAttachmentFilenames([reference({ text: 'a quoted passage' })])).toEqual([])
  })
})
