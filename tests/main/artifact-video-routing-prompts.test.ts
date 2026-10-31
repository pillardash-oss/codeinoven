import { describe, expect, it } from 'vitest'
import { ARTIFACT_CAPABILITY_DOCS, ARTIFACT_CAPABILITY_SUMMARY } from '../../src/lib/artifact-skill'
import { VIDEO_CAPABILITY_SUMMARY, videoCapabilityDocs } from '../../src/lib/video-skill'
import { ARTIFACT_OUTPUT_INSTRUCTION } from '../../src/main/chat/chat-engine/chat-engine-prompts'
import {
  videoSessionBriefing,
  videoSessionContinuation
} from '../../src/main/utilities/cio-video-prompt'

/**
 * The routing a video request has to survive.
 *
 * A user asking for "a video walkthrough of what you did" is asking for something
 * to watch once, and the failure this suite exists for is the one that turns that
 * request into something else: an editable project handed back as homework, a
 * page of HTML, or a promise that a file exists. The text that decides it is
 * spread across the two capability contracts, the turn instruction and the video
 * session's own contract, so every one of them is read here rather than trusted
 * to stay in step by hand.
 *
 * These assertions are about the promises the text makes, not its wording: a
 * capability may be reworded freely, and what it may not do is stop telling the
 * agent which capability makes the video and that the film can be made with
 * nothing installed.
 */
describe('video request routing', () => {
  it('names the video capability as the only maker of a video', () => {
    expect(ARTIFACT_CAPABILITY_SUMMARY).toContain('cio:video')
    expect(ARTIFACT_CAPABILITY_SUMMARY).toContain('never produces one')
    expect(ARTIFACT_CAPABILITY_DOCS).toContain('This capability never produces a video')
    expect(ARTIFACT_CAPABILITY_DOCS).toContain('cio:video')
    // The render call is the delivery step, so the contract cannot leave it out.
    expect(ARTIFACT_CAPABILITY_DOCS).toContain('render')
  })

  it('tells the artifact agent what to do when the video capability cannot run', () => {
    expect(ARTIFACT_CAPABILITY_DOCS).toContain('If the video capability cannot run')
    expect(ARTIFACT_CAPABILITY_DOCS).toContain('Work with what exists')
  })

  it('advertises both video deliverables before the agent chooses', () => {
    const docs = videoCapabilityDocs()
    expect(VIDEO_CAPABILITY_SUMMARY).toContain('throwaway')
    expect(VIDEO_CAPABILITY_SUMMARY).toContain('Nothing needs installing')
    expect(docs).toContain('## Which video the user is asking for')
    expect(docs).toContain('editable composition')
    expect(docs).toContain('throwaway delivery')
    // A delivery is built somewhere the board does not list, and delivered.
    expect(docs).toContain('.cio/work/<feature>/recap/')
    expect(docs).toContain('export it once')
    expect(docs).toContain('artifact capability')
  })

  it('authorises the one export a delivery needs without loosening the rest', () => {
    const docs = videoCapabilityDocs()
    expect(docs).toContain('A request to watch something is an export request')
    expect(docs).toContain('does not authorize re-exporting after every later edit')
  })

  it('works from the barest minimum instead of dead-ending on an install', () => {
    const docs = videoCapabilityDocs()
    expect(docs).toContain('## Work with what is installed')
    expect(docs).toContain('needs nothing installed')
    expect(docs).toContain('ask for it in the same turn')
    expect(docs).toContain('Never install a pack')
  })

  it('routes the turn instruction through the video capability and still delivers inline', () => {
    expect(ARTIFACT_OUTPUT_INSTRUCTION).toContain('cio:video')
    expect(ARTIFACT_OUTPUT_INSTRUCTION).toContain('export it once')
    expect(ARTIFACT_OUTPUT_INSTRUCTION).toContain('operation render')
    expect(ARTIFACT_OUTPUT_INSTRUCTION).toContain('Work with what is installed')
    // The old rule sent a video request at the artifact capability directly.
    expect(ARTIFACT_OUTPUT_INSTRUCTION).not.toContain(
      'generation or editing of a standalone image, graphic, audio or video'
    )
  })

  it('gives the video session the same split, including where a delivery is built', () => {
    const briefing = videoSessionBriefing('activation', '.cio/videos')
    expect(briefing).toContain('throwaway delivery')
    expect(briefing).toContain('.cio/work/<feature>/recap/')
    expect(briefing).toContain('never moved onto the board')
    expect(briefing).toContain('Work with what is installed')
    expect(videoSessionContinuation('.cio/videos')).toContain('throwaway walkthrough')
  })
})
