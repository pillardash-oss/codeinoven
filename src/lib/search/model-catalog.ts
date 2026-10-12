import type { SearchArchitecture, SearchModelArtifact, SearchPlatform } from './types'

/**
 * Static catalog of embedding models the Search settings page offers.
 *
 * Every entry is pinned to an immutable Hugging Face revision with a SHA-256
 * digest and byte size, so a download is verified before it is installed. The
 * listing is runtime-aware: entries are filtered by the runtime actually
 * available on the machine, so it is never gguf-only by construction.
 *
 * EmbeddingGemma prompt format (from the model card):
 *   query    -> `task: search result | query: {content}`
 *   document -> `title: {title} | text: {content}`
 * The document form is expressed as a prefix plus a title/body body below.
 */
const EMBEDDINGGEMMA_QUERY_PREFIX = 'task: search result | query: '
const EMBEDDINGGEMMA_DOCUMENT_PREFIX = 'title: none | text: '

const GEMMA_LICENSE = 'Gemma Terms of Use'
const GEMMA_ATTRIBUTION =
  'EmbeddingGemma 300M by Google DeepMind, converted to GGUF by the listed publisher.'

const ALL_PLATFORMS: readonly SearchPlatform[] = ['darwin', 'win32', 'linux']
const ALL_ARCHITECTURES: readonly SearchArchitecture[] = ['arm64', 'x64']

function huggingFaceUrl(revision: string, repository: string, file: string): string {
  return `https://huggingface.co/${repository}/resolve/${revision}/${file}`
}

export const SEARCH_MODEL_CATALOG: readonly SearchModelArtifact[] = [
  {
    id: 'embeddinggemma-300m-q8-0',
    runtime: 'gguf',
    label: 'EmbeddingGemma 300M · Q8_0',
    description:
      'Google DeepMind embedding model quantized to 8-bit. The balanced default: near-lossless retrieval at a modest size.',
    quantization: 'Q8_0',
    dimensions: 768,
    contextTokens: 2048,
    queryPrefix: EMBEDDINGGEMMA_QUERY_PREFIX,
    documentPrefix: EMBEDDINGGEMMA_DOCUMENT_PREFIX,
    platforms: ALL_PLATFORMS,
    architectures: ALL_ARCHITECTURES,
    files: [
      {
        path: 'embeddinggemma-300M-Q8_0.gguf',
        sourceUrl: huggingFaceUrl(
          '0f741b5a6585bd53aeb15cd1372c56f2a0f65e12',
          'ggml-org/embeddinggemma-300M-GGUF',
          'embeddinggemma-300M-Q8_0.gguf'
        ),
        byteSize: 333590944,
        sha256: 'b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63'
      }
    ],
    byteSize: 333590944,
    license: GEMMA_LICENSE,
    attribution: GEMMA_ATTRIBUTION,
    sourcePageUrl: 'https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF',
    minimumMemoryBytes: 900_000_000
  },
  {
    id: 'embeddinggemma-300m-q4-0',
    runtime: 'gguf',
    label: 'EmbeddingGemma 300M · Q4_0',
    description:
      'Smallest 4-bit quantization. Fastest to download and run when disk or memory is tight, at some cost to retrieval quality.',
    quantization: 'Q4_0',
    dimensions: 768,
    contextTokens: 2048,
    queryPrefix: EMBEDDINGGEMMA_QUERY_PREFIX,
    documentPrefix: EMBEDDINGGEMMA_DOCUMENT_PREFIX,
    platforms: ALL_PLATFORMS,
    architectures: ALL_ARCHITECTURES,
    files: [
      {
        path: 'embeddinggemma-300m-Q4_0.gguf',
        sourceUrl: huggingFaceUrl(
          '6661a6504c30d8304af13455cb4a5d4f5bc6011f',
          'unsloth/embeddinggemma-300m-GGUF',
          'embeddinggemma-300m-Q4_0.gguf'
        ),
        byteSize: 277852192,
        sha256: 'edc6015cb15694c27be7d1d33f1bc015db9a358ff51ed524628c027504907ba9'
      }
    ],
    byteSize: 277852192,
    license: GEMMA_LICENSE,
    attribution: GEMMA_ATTRIBUTION,
    sourcePageUrl: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF',
    minimumMemoryBytes: 850_000_000
  },
  {
    id: 'embeddinggemma-300m-bf16',
    runtime: 'gguf',
    label: 'EmbeddingGemma 300M · BF16',
    description:
      'Full-precision bfloat16 weights. Higher fidelity than any quantized build, at roughly twice the disk and memory.',
    quantization: 'BF16',
    dimensions: 768,
    contextTokens: 2048,
    queryPrefix: EMBEDDINGGEMMA_QUERY_PREFIX,
    documentPrefix: EMBEDDINGGEMMA_DOCUMENT_PREFIX,
    platforms: ALL_PLATFORMS,
    architectures: ALL_ARCHITECTURES,
    files: [
      {
        path: 'embeddinggemma-300M-BF16.gguf',
        sourceUrl: huggingFaceUrl(
          '6661a6504c30d8304af13455cb4a5d4f5bc6011f',
          'unsloth/embeddinggemma-300m-GGUF',
          'embeddinggemma-300M-BF16.gguf'
        ),
        byteSize: 612429792,
        sha256: '95a1f284251f78a1409a9c9e52dd4026c2180b13a90a5ede2a878bb8141fba08'
      }
    ],
    byteSize: 612429792,
    license: GEMMA_LICENSE,
    attribution: GEMMA_ATTRIBUTION,
    sourcePageUrl: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF',
    minimumMemoryBytes: 1_300_000_000
  },
  {
    id: 'embeddinggemma-300m-f32',
    runtime: 'gguf',
    label: 'EmbeddingGemma 300M · F32',
    description:
      'Unquantized 32-bit weights for reference-grade quality. Largest download and memory footprint.',
    quantization: 'F32',
    dimensions: 768,
    contextTokens: 2048,
    queryPrefix: EMBEDDINGGEMMA_QUERY_PREFIX,
    documentPrefix: EMBEDDINGGEMMA_DOCUMENT_PREFIX,
    platforms: ALL_PLATFORMS,
    architectures: ALL_ARCHITECTURES,
    files: [
      {
        path: 'embeddinggemma-300M-F32.gguf',
        sourceUrl: huggingFaceUrl(
          '6661a6504c30d8304af13455cb4a5d4f5bc6011f',
          'unsloth/embeddinggemma-300m-GGUF',
          'embeddinggemma-300M-F32.gguf'
        ),
        byteSize: 1217982432,
        sha256: 'a3125072128fc76d1c1d8d19f7b095c7e3bfbf00594dcf8a8bd3bcb334935d57'
      }
    ],
    byteSize: 1217982432,
    license: GEMMA_LICENSE,
    attribution: GEMMA_ATTRIBUTION,
    sourcePageUrl: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF',
    minimumMemoryBytes: 1_900_000_000
  }
]

/** Catalog entries whose runtime and platform match the current machine. */
export function searchModelsForRuntime(
  catalog: readonly SearchModelArtifact[],
  runtime: string,
  platform: SearchPlatform,
  architecture: SearchArchitecture
): SearchModelArtifact[] {
  return catalog.filter(
    (artifact) =>
      artifact.runtime === runtime &&
      artifact.platforms.includes(platform) &&
      artifact.architectures.includes(architecture)
  )
}
