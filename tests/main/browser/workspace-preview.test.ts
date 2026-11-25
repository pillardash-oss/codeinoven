import { describe, expect, it } from 'vitest'

import {
  BrowserServiceWorkspacePreview,
  workspacePreviewUrl
} from '../../../src/main/browser/browser-service/browser-service-workspace-preview'

/**
 * A chat has the in-app browser, but the browser only navigates http(s) and a
 * chat's folder has no server: chat d470263e wrote a page and could not open it.
 * `preview` serves the conversation's own mount root on the loopback origin the
 * app already runs, so a written page has an address to `open`.
 */
describe('workspace preview for the in-app browser', () => {
  it('joins a relative path onto the preview origin', () => {
    expect(workspacePreviewUrl('http://127.0.0.1:4100', '.cio/tmp/report.html')).toBe(
      'http://127.0.0.1:4100/.cio/tmp/report.html'
    )
    expect(workspacePreviewUrl('http://127.0.0.1:4100/', '/site/index.html')).toBe(
      'http://127.0.0.1:4100/site/index.html'
    )
    expect(workspacePreviewUrl('http://127.0.0.1:4100', '')).toBe('http://127.0.0.1:4100')
    // A space or a hash must survive as part of the name, not break the URL.
    expect(workspacePreviewUrl('http://127.0.0.1:4100', 'my page.html')).toBe(
      'http://127.0.0.1:4100/my%20page.html'
    )
  })

  it('refuses a path that escapes the conversation folder', () => {
    expect(workspacePreviewUrl('http://127.0.0.1:4100', '../other-thread/page.html')).toBeNull()
    expect(workspacePreviewUrl('http://127.0.0.1:4100', 'a/../../etc/passwd')).toBeNull()
    expect(workspacePreviewUrl('http://127.0.0.1:4100', '/etc/passwd')).toBe(
      'http://127.0.0.1:4100/etc/passwd'
    )
  })

  it('serves the conversation mount root and reports it', async () => {
    const calls: string[] = []
    const unit = new BrowserServiceWorkspacePreview()
    unit.attach({
      resolveMountRoot: async (projectId, _scope, threadId) => {
        calls.push(`${projectId}:${threadId ?? ''}`)
        return '/tmp/cio/chats-cwd/thread-1'
      },
      openPreview: async (root) => {
        calls.push(root)
        return { url: 'http://127.0.0.1:4101' }
      }
    })
    await expect(unit.serve({ projectId: 'inbox', threadId: 'thread-1' })).resolves.toEqual({
      url: 'http://127.0.0.1:4101',
      root: '/tmp/cio/chats-cwd/thread-1',
      path: ''
    })
    expect(calls).toEqual(['inbox:thread-1', '/tmp/cio/chats-cwd/thread-1'])
  })

  it('says preview is unavailable instead of implying there is no server', async () => {
    const unit = new BrowserServiceWorkspacePreview()
    await expect(unit.serve({ projectId: 'inbox', threadId: 'thread-1' })).rejects.toThrow(
      'Workspace preview is unavailable'
    )
  })
})
