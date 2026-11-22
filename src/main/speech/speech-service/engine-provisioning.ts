import type { SpeechRuntime } from '../../../lib/speech/types'
import { MlxMetalRuntime } from '../mlx-metal-runtime'
import { SherpaRuntime, bundledSherpaWrapper } from '../sherpa-runtime'

/**
 * The two speech engines whose binaries are provisioned on demand instead of
 * shipped with the app.
 *
 * MLX needs a Metal kernel library and sherpa-onnx needs a native addon plus
 * onnxruntime, together more than 130 MB that most installs never touch. The
 * engine acquires them when a model that needs one is downloaded, and the
 * settings surface can install either one directly. Keeping that acquisition
 * out of `SpeechService` leaves that class with the job of running speech
 * rather than installing it.
 */
export class SpeechEngineProvisioning {
  readonly mlx: MlxMetalRuntime
  readonly sherpa: SherpaRuntime

  constructor(mlxWorkerPath: string) {
    this.mlx = new MlxMetalRuntime(mlxWorkerPath)
    this.sherpa = new SherpaRuntime(bundledSherpaWrapper())
  }

  /**
   * Provision whatever a model artifact needs, before its own bytes start
   * moving. Runtimes that ship with the app need nothing here, and a retired
   * artifact never starts a download at all.
   */
  async provisionFor(runtime: SpeechRuntime): Promise<void> {
    if (runtime === 'mlx') await this.mlx.ensure()
    else if (runtime === 'sherpa-onnx') await this.sherpa.ensure()
  }

  mlxStatus(): ReturnType<MlxMetalRuntime['status']> {
    return this.mlx.status()
  }

  sherpaStatus(): ReturnType<SherpaRuntime['status']> {
    return this.sherpa.status()
  }

  async downloadMlx(signal?: AbortSignal): Promise<void> {
    await this.mlx.download(signal)
  }

  async downloadSherpa(signal?: AbortSignal): Promise<void> {
    await this.sherpa.download(signal)
  }
}
