import { describe, expect, it } from 'vitest'
import {
  threadArtifactLocationForUrl,
  threadArtifactRelativePath
} from '../../../src/renderer/lib/thread-artifact-url'

const PROJECT = '4edbfe468025f6bcf31ef361'
const THREAD = '9100004f337b36f32264ef04'
const REL = '.cio/work/social-meta-image/codeinoven-social-meta.png'

describe('threadArtifactLocationForUrl', () => {
  it('parses a thread artifact URL with a version query', () => {
    expect(
      threadArtifactLocationForUrl(
        `appfile://thread/${PROJECT}/${THREAD}/${REL}?v=1791417866323.2605`
      )
    ).toEqual({ projectId: PROJECT, threadId: THREAD, relativePath: REL })
  })

  it('parses a project URL without a thread', () => {
    expect(threadArtifactLocationForUrl(`appfile://project/${PROJECT}/${REL}`)).toEqual({
      projectId: PROJECT,
      relativePath: REL
    })
  })

  it('rejects other schemes, hosts, traversal, and empty paths', () => {
    expect(threadArtifactLocationForUrl(`file:///Users/x/${REL}`)).toBeNull()
    expect(threadArtifactLocationForUrl(`appfile://attachment/${PROJECT}/abc?name=x.png`)).toBeNull()
    expect(threadArtifactLocationForUrl(`appfile://thread/${PROJECT}/${THREAD}/`)).toBeNull()
    expect(
      threadArtifactLocationForUrl(`appfile://thread/${PROJECT}/${THREAD}/../secret.png`)
    ).toBeNull()
    expect(threadArtifactLocationForUrl('appfile://thread/%zz')).toBeNull()
  })
})

describe('threadArtifactRelativePath', () => {
  it('returns the relative path only for this thread', () => {
    const url = `appfile://thread/${PROJECT}/${THREAD}/${REL}?v=1`
    expect(threadArtifactRelativePath(url, PROJECT, THREAD)).toBe(REL)
    expect(threadArtifactRelativePath(url, PROJECT, 'other-thread')).toBeNull()
    expect(threadArtifactRelativePath(url, 'other-project', THREAD)).toBeNull()
  })

  it('accepts project URLs for this project', () => {
    expect(
      threadArtifactRelativePath(`appfile://project/${PROJECT}/${REL}`, PROJECT, THREAD)
    ).toBe(REL)
  })
})
