import type { SearchArchitecture, SearchModelArtifact, SearchPlatform } from './types'

/**
 * Static catalog of embedding models the Search settings page offers.
 *
 * Every entry is pinned to an immutable Hugging Face revision with a SHA-256
 * digest and byte size, so a download is verified before it is installed. The
 * listing is runtime-aware: entries are filtered by the runtime actually
 * available on the machine, so it is never gguf-only by construction.
 *
 * The model is EmbeddingGemma 2 (Google DeepMind): a 768-dimension multilingual
 * embedding model with an 8K token context. Its prompt format (from the model
 * card) is:
 *   query    -> `task: search result | query: {content}`
 *   document -> `title: {title} | text: {content}`
 * The document form is expressed as a prefix plus a title/body body below.
 * Prefixes apply to text only and are unchanged from the first generation.
 */
const EMBEDDINGGEMMA2_QUERY_PREFIX = 'task: search result | query: '
const EMBEDDINGGEMMA2_DOCUMENT_PREFIX = 'title: none | text: '

/** Native output width. Matryoshka truncation to 512/256/128 is also supported. */
const EMBEDDINGGEMMA2_DIMENSIONS = 768
/** 8K token context window. */
const EMBEDDINGGEMMA2_CONTEXT_TOKENS = 8192

const GEMMA2_LICENSE = 'Apache 2.0'
const GGML_ATTRIBUTION = 'EmbeddingGemma 2 by Google DeepMind, converted to GGUF by ggml-org.'
const UNSLOTH_ATTRIBUTION = 'EmbeddingGemma 2 by Google DeepMind, quantized by Unsloth.'

const ALL_PLATFORMS: readonly SearchPlatform[] = ['darwin', 'win32', 'linux']
const ALL_ARCHITECTURES: readonly SearchArchitecture[] = ['arm64', 'x64']

const GGML_REVISION = 'bfcd298762cc34d0357ece5ebdd31791a3a374d8'
const UNSLOTH_REVISION = '031f0d4b35536f69ab3509d4893c923264fcf253'

function huggingFaceUrl(revision: string, repository: string, file: string): string {
  return `https://huggingface.co/${repository}/resolve/${revision}/${file}`
}

interface ArtifactSeed {
  id: string
  label: string
  quantization: string
  description: string
  repository: string
  revision: string
  file: string
  byteSize: number
  sha256: string
  minimumMemoryBytes: number
}

const GEMMA2_SEEDS: readonly ArtifactSeed[] = [
  {
    id: 'embeddinggemma-2-ud-q4-k-xl',
    label: 'EmbeddingGemma 2 · UD-Q4_K_XL',
    quantization: 'Q4_K_XL',
    description:
      'Smallest Unsloth dynamic quantization. The quickest download and the lightest memory, at some cost to retrieval precision.',
    repository: 'unsloth/embeddinggemma-2-GGUF',
    revision: UNSLOTH_REVISION,
    file: 'embeddinggemma-2-UD-Q4_K_XL.gguf',
    byteSize: 175673856,
    sha256: 'ea905fd08e8061db77a0031cbb5096d459d7cfd2bdd0ad2ba66e483f16719493',
    minimumMemoryBytes: 700_000_000
  },
  {
    id: 'embeddinggemma-2-ud-q5-k-xl',
    label: 'EmbeddingGemma 2 · UD-Q5_K_XL',
    quantization: 'Q5_K_XL',
    description:
      'Balanced Unsloth dynamic quantization. Near-full retrieval quality at roughly a third of full-precision size.',
    repository: 'unsloth/embeddinggemma-2-GGUF',
    revision: UNSLOTH_REVISION,
    file: 'embeddinggemma-2-UD-Q5_K_XL.gguf',
    byteSize: 210055680,
    sha256: 'a9d7a3b7eb421113f05e964e10882676f10fff83811b7876d5bb983db7c7ac41',
    minimumMemoryBytes: 800_000_000
  },
  {
    id: 'embeddinggemma-2-ud-q6-k-xl',
    label: 'EmbeddingGemma 2 · UD-Q6_K_XL',
    quantization: 'Q6_K_XL',
    description:
      'Higher-fidelity Unsloth dynamic quantization. A close match to 8-bit quality in a smaller file.',
    repository: 'unsloth/embeddinggemma-2-GGUF',
    revision: UNSLOTH_REVISION,
    file: 'embeddinggemma-2-UD-Q6_K_XL.gguf',
    byteSize: 248812032,
    sha256: 'dc84f042bc3ffbe6122b3b38b2fb299d66f5f37b276c9d458db85d4a4f1e6ba3',
    minimumMemoryBytes: 900_000_000
  },
  {
    id: 'embeddinggemma-2-q8-0',
    label: 'EmbeddingGemma 2 · Q8_0',
    quantization: 'Q8_0',
    description:
      'Canonical 8-bit conversion from ggml-org. Effectively lossless retrieval and the recommended default.',
    repository: 'ggml-org/embeddinggemma-2-GGUF',
    revision: GGML_REVISION,
    file: 'embeddinggemma-2-Q8_0.gguf',
    byteSize: 309855456,
    sha256: '2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135',
    minimumMemoryBytes: 1_000_000_000
  },
  {
    id: 'embeddinggemma-2-bf16',
    label: 'EmbeddingGemma 2 · BF16',
    quantization: 'BF16',
    description:
      'Full-precision bfloat16 weights. Reference fidelity for measuring a quantized build against, at twice the footprint.',
    repository: 'ggml-org/embeddinggemma-2-GGUF',
    revision: GGML_REVISION,
    file: 'embeddinggemma-2-BF16.gguf',
    byteSize: 557950176,
    sha256: '68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216',
    minimumMemoryBytes: 1_500_000_000
  }
]

function toArtifact(seed: ArtifactSeed): SearchModelArtifact {
  const unsloth = seed.repository.startsWith('unsloth/')
  return {
    id: seed.id,
    runtime: 'gguf',
    label: seed.label,
    description: seed.description,
    quantization: seed.quantization,
    dimensions: EMBEDDINGGEMMA2_DIMENSIONS,
    contextTokens: EMBEDDINGGEMMA2_CONTEXT_TOKENS,
    queryPrefix: EMBEDDINGGEMMA2_QUERY_PREFIX,
    documentPrefix: EMBEDDINGGEMMA2_DOCUMENT_PREFIX,
    platforms: ALL_PLATFORMS,
    architectures: ALL_ARCHITECTURES,
    files: [
      {
        path: seed.file,
        sourceUrl: huggingFaceUrl(seed.revision, seed.repository, seed.file),
        byteSize: seed.byteSize,
        sha256: seed.sha256
      }
    ],
    byteSize: seed.byteSize,
    license: GEMMA2_LICENSE,
    attribution: unsloth ? UNSLOTH_ATTRIBUTION : GGML_ATTRIBUTION,
    sourcePageUrl: `https://huggingface.co/${seed.repository}`,
    minimumMemoryBytes: seed.minimumMemoryBytes
  }
}

export const SEARCH_MODEL_CATALOG: readonly SearchModelArtifact[] = GEMMA2_SEEDS.map(toArtifact)

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
