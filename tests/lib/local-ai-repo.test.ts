import { describe, expect, it } from 'vitest'
import { decideLocalAiRepoEngine } from '$shared/local-ai-repo'

/**
 * These facts come from the repositories this app has actually been pointed at:
 * LFM3 Omni is MLX weights for an architecture mlx-lm does not have, and the GGUF
 * conversion of the same family is what llama.cpp loads.
 */
describe('decideLocalAiRepoEngine', () => {
  it('sends a GGUF repository to llama.cpp, whichever tab saved the row', () => {
    const decision = decideLocalAiRepoEngine({
      modelType: 'lfm2',
      weights: 'gguf',
      mlxArchitectures: ['lfm2']
    })

    expect(decision.kind).toBe('engine')
    expect(decision.kind === 'engine' && decision.engine).toBe('llama.cpp')
  })

  it('sends MLX weights the installed mlx-lm implements to the MLX engine', () => {
    const decision = decideLocalAiRepoEngine({
      modelType: 'qwen3',
      weights: 'mlx',
      mlxArchitectures: ['qwen3', 'lfm2']
    })

    expect(decision.kind).toBe('engine')
    expect(decision.kind === 'engine' && decision.engine).toBe('mlx')
  })

  it('refuses MLX weights for an architecture mlx-lm does not have, and names the runtime that does', () => {
    const decision = decideLocalAiRepoEngine({
      modelType: 'lfm3_omni',
      weights: 'mlx',
      mlxArchitectures: ['lfm2', 'qwen3']
    })

    expect(decision.kind).toBe('unsupported')
    expect(decision.message).toContain('lfm3_omni')
    expect(decision.message).toContain('mlx-vlm')
  })

  it('refuses a plain Torch checkpoint instead of downloading it', () => {
    const decision = decideLocalAiRepoEngine({
      modelType: 'lfm3_omni',
      weights: 'torch',
      mlxArchitectures: []
    })

    expect(decision.kind).toBe('unsupported')
    expect(decision.message).toContain('not GGUF files or MLX weights')
  })

  it('leaves the row alone when the repository could not be read', () => {
    const decision = decideLocalAiRepoEngine({
      modelType: '',
      weights: 'unknown',
      mlxArchitectures: []
    })

    expect(decision.kind).toBe('unknown')
  })
})
