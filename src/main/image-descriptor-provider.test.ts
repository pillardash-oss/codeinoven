import { describe, expect, it, vi } from 'vitest'
import {
  assembleBatchedImageDescriptorResults,
  decideImageDescriptorBatch,
  runImageDescriptorBatch,
  type ImageDescriptorBatchCapability,
  type ImageDescriptorResult,
  type ResolvedImageEntry
} from './image-descriptor-provider'
import { imageDescriptorBatchCapability } from './services/image-descriptor'

const DATA = 'data:image/png;base64,iVBORw0KGgo='

function entry(id: string): ResolvedImageEntry {
  return {
    id,
    source: DATA,
    type: 'binary',
    attachment: { mime: 'image/png', url: DATA }
  }
}

function batchingCapability(
  maxImages: number,
  supportsBatch = true
): ImageDescriptorBatchCapability {
  return { supportsBatch, maxImages }
}

describe('decideImageDescriptorBatch', () => {
  it('uses the batched path for a compatible harness within the image limit', () => {
    expect(decideImageDescriptorBatch([entry('a'), entry('b')], batchingCapability(4))).toEqual({
      mode: 'batch'
    })
  })

  it('falls back to sequential when the harness cannot attach multiple images', () => {
    expect(decideImageDescriptorBatch([entry('a')], batchingCapability(4, false))).toEqual({
      mode: 'sequential',
      reason: 'harness_does_not_batch'
    })
  })

  it('falls back to sequential when the request exceeds the image limit', () => {
    expect(decideImageDescriptorBatch([entry('a'), entry('b')], batchingCapability(1))).toEqual({
      mode: 'sequential',
      reason: 'too_many_images'
    })
  })
})

describe('imageDescriptorBatchCapability', () => {
  it('derives batch support from the harness attachments capability', () => {
    const withAttachments = {
      runtimeTopology: { kind: 'shared_server', scope: 'application' },
      attachments: true,
      streaming: true,
      steering: true,
      nativeResume: true,
      messageHistory: 'native',
      interactivePermissions: true,
      commands: true,
      providerCatalog: true,
      sessionStatus: true,
      contextUsage: true,
      compaction: true,
      subagents: true
    } as const
    expect(imageDescriptorBatchCapability(withAttachments, 5)).toEqual({
      supportsBatch: true,
      maxImages: 5
    })
  })

  it('disables batching for a harness that cannot attach images', () => {
    const withoutAttachments = {
      runtimeTopology: { kind: 'turn_process', scope: 'session' },
      attachments: false,
      streaming: true,
      steering: true,
      nativeResume: true,
      messageHistory: 'mirrored',
      interactivePermissions: false,
      commands: true,
      providerCatalog: false,
      sessionStatus: false,
      contextUsage: false,
      compaction: false,
      subagents: false
    } as const
    expect(imageDescriptorBatchCapability(withoutAttachments, 5)).toEqual({
      supportsBatch: false,
      maxImages: 5
    })
  })
})

describe('runImageDescriptorBatch', () => {
  it('makes exactly one batched vision call and passes the stable feature call id', async () => {
    const images = [entry('a'), entry('b'), entry('c')]
    const batchCall = vi.fn(async (_: ResolvedImageEntry[], featureCallId: string) => ({
      results: [
        { id: 'a', description: 'first' },
        { id: 'b', description: 'second' },
        { id: 'c', description: 'third' }
      ],
      featureCallId
    }))
    const singleCall = vi.fn()

    const run = await runImageDescriptorBatch(images, batchingCapability(4), batchCall, singleCall)

    expect(run.mode).toBe('batch')
    expect(run.featureCallId).toEqual(expect.any(String))
    expect(batchCall).toHaveBeenCalledTimes(1)
    expect(batchCall.mock.calls[0]?.[1]).toBe(run.featureCallId)
    expect(singleCall).not.toHaveBeenCalled()
    expect(run.results.map((result) => result.description)).toEqual(['first', 'second', 'third'])
  })

  it('runs one sequential call per image for a non-batching harness', async () => {
    const images = [entry('a'), entry('b')]
    const batchCall = vi.fn()
    const singleCall = vi.fn(async (image: ResolvedImageEntry): Promise<ImageDescriptorResult> => ({
      id: image.id,
      source: image.source,
      type: image.type,
      description: `described ${image.id}`
    }))

    const run = await runImageDescriptorBatch(
      images,
      batchingCapability(4, false),
      batchCall,
      singleCall
    )

    expect(run.mode).toBe('sequential')
    expect(batchCall).not.toHaveBeenCalled()
    expect(singleCall).toHaveBeenCalledTimes(2)
    expect(run.results.map((result) => result.description)).toEqual(['described a', 'described b'])
  })

  it('falls back to one call per image for an oversized request', async () => {
    const images = [entry('a'), entry('b')]
    const batchCall = vi.fn()
    const singleCall = vi.fn(async (image: ResolvedImageEntry): Promise<ImageDescriptorResult> => ({
      id: image.id,
      source: image.source,
      type: image.type,
      description: `described ${image.id}`
    }))

    const run = await runImageDescriptorBatch(images, batchingCapability(1), batchCall, singleCall)

    expect(run.mode).toBe('sequential')
    expect(batchCall).not.toHaveBeenCalled()
    expect(singleCall).toHaveBeenCalledTimes(2)
  })
})

describe('assembleBatchedImageDescriptorResults', () => {
  it('maps each output to its image by id, preserving input order even when output is reordered', () => {
    const images = [entry('a'), entry('b'), entry('c')]
    const output = {
      results: [
        { id: 'c', description: 'c desc' },
        { id: 'a', description: 'a desc' },
        { id: 'b', description: 'b desc' }
      ]
    }
    const results = assembleBatchedImageDescriptorResults(images, output)
    expect(results.map((result) => [result.id, result.description])).toEqual([
      ['a', 'a desc'],
      ['b', 'b desc'],
      ['c', 'c desc']
    ])
    expect(results.every((result) => result.error === undefined)).toBe(true)
  })

  it('reports an error on the image itself when the model omits its entry', () => {
    const images = [entry('a'), entry('b')]
    const output = { results: [{ id: 'a', description: 'a desc' }] }
    const results = assembleBatchedImageDescriptorResults(images, output)
    expect(results[0]?.description).toBe('a desc')
    expect(results[0]?.error).toBeUndefined()
    expect(results[1]?.description).toBe('')
    expect(results[1]?.error).toContain('no description')
  })

  it('never mislabels a partial or malformed entry as another image', () => {
    const images = [entry('a'), entry('b'), entry('c')]
    const output = {
      results: [
        { id: 'a', description: 'a desc' },
        { id: 'unknown', description: 'orphan desc' },
        { id: 'b', description: '   ' }
      ]
    }
    const results = assembleBatchedImageDescriptorResults(images, output)
    expect(results[0]?.description).toBe('a desc')
    expect(results[1]?.description).toBe('')
    expect(results[1]?.error).toBeDefined()
    expect(results[2]?.description).toBe('')
    expect(results[2]?.error).toBeDefined()
    expect(results.every((result) => result.id === images[results.indexOf(result)]?.id)).toBe(true)
  })

  it('keeps every result attributed to its own image when the whole output is malformed', () => {
    const images = [entry('a'), entry('b')]
    const output = 'not structured output at all'
    const results = assembleBatchedImageDescriptorResults(images, output)
    expect(results).toHaveLength(2)
    for (const result of results) {
      expect(result.description).toBe('')
      expect(result.error).toBeDefined()
    }
    expect(results[0]?.id).toBe('a')
    expect(results[1]?.id).toBe('b')
  })
})
