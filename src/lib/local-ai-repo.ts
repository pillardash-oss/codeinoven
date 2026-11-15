/**
 * Which engine of ours can serve a Hugging Face repository, decided from the
 * repository itself rather than from which tab the row was saved under.
 *
 * A row is a name and a reference; the reference is a fact about a repository that
 * can be read before anything is fetched. Reading it first is what keeps a 2.7 GB
 * download from starting for a model no engine here can load, and it is also what
 * lets a row saved under the wrong engine run, because the repository says which
 * one it belongs to.
 *
 * The two engines accept disjoint weight formats: llama.cpp loads GGUF files, and
 * mlx-lm loads MLX-quantised safetensors whose architecture it implements. A
 * repository carrying neither is not something this app can run, and saying so is
 * the honest answer instead of a download that ends in a crash.
 */
import type { LocalAiRuntimeId } from './llama-cpp'

/** What the repository's own files say about it. */
export interface LocalAiRepoFacts {
  /** `model_type` from its `config.json`, empty when that could not be read. */
  modelType: string
  /**
   * The weight format, from the config: an MLX quantisation block is MLX weights,
   * a repository with `.gguf` files is a GGUF conversion, and anything else is a
   * plain Torch checkpoint.
   */
  weights: 'mlx' | 'gguf' | 'torch' | 'unknown'
  /** Architectures the installed mlx-lm implements, lowercased. */
  mlxArchitectures: readonly string[]
}

export type LocalAiRepoDecision =
  | { kind: 'engine'; engine: LocalAiRuntimeId; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'unknown'; message: string }

/** The architecture name as mlx-lm would spell its module. */
function architectureKey(modelType: string): string {
  return modelType.trim().toLowerCase()
}

/**
 * The engine that runs this repository, or why none of ours does.
 *
 * `unknown` is the one answer that leaves the row alone: a repository whose
 * metadata could not be read is not evidence that it cannot run, and guessing from
 * a failed fetch would break rows that work today.
 */
export function decideLocalAiRepoEngine(facts: LocalAiRepoFacts): LocalAiRepoDecision {
  if (facts.weights === 'gguf') {
    return {
      kind: 'engine',
      engine: 'llama.cpp',
      message: 'This repository ships GGUF weights, so the llama.cpp engine runs it.'
    }
  }
  if (facts.weights === 'mlx') {
    const architecture = architectureKey(facts.modelType)
    if (architecture.length > 0 && facts.mlxArchitectures.includes(architecture)) {
      return {
        kind: 'engine',
        engine: 'mlx',
        message: `These are MLX weights and the installed mlx-lm implements ${facts.modelType}.`
      }
    }
    return {
      kind: 'unsupported',
      message:
        architecture.length === 0
          ? 'These are MLX weights but the repository names no architecture, so mlx-lm cannot load them.'
          : `These are MLX weights for ${facts.modelType}, an architecture mlx-lm does not implement. Omni and vision MLX models are served by mlx-vlm, which this app does not run.`
    }
  }
  if (facts.weights === 'torch') {
    return {
      kind: 'unsupported',
      message: `This repository holds ${facts.modelType || 'a Torch'} checkpoints, not GGUF files or MLX weights, so neither engine here can load it.`
    }
  }
  return {
    kind: 'unknown',
    message: 'The repository metadata could not be read, so the row runs on its own engine.'
  }
}
