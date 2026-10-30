import { designCapabilityDocs } from '../../../lib/design-skill'
import { videoCapabilityDocs } from '../../../lib/video-skill'
import { prototypeCdnPolicyFromConfig } from '../../../lib/prototypes/prototype-cdn'
import { type CuaSnapshotView } from '../../../lib/cua-driver'
import { cuaViewKey } from '../utility-orchestration-service'
import type {
  AppControlExecutor,
  BrowserUtilityExecutor,
  CuaOperationEvent,
  DesignCapabilityExecutor,
  EngineeringToolExecutor,
  OrchestrationExecutor,
  PawnToolExecutor,
  SecretRequestExecutor,
  TurnState,
  VideoCapabilityExecutor
} from '../utility-orchestration-service'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/** UtilityOrchestrationService executors: one concern, moved verbatim from the composition root. */
export class UtilityOrchestrationServiceExecutors {
  constructor(private readonly host: UtilityOrchestrationService) {}

  setArtifactExecutor(executor: DesignCapabilityExecutor | null): void {
    this.host.artifactExecutor = executor
  }

  setBrowserExecutor(executor: BrowserUtilityExecutor | null): void {
    this.host.browserExecutor = executor
  }

  /**
   * Register the executor behind the app-owned `cio:design` capability's
   * `preview` operation. The design pass itself is text; what the app adds is
   * the ability to serve the folder it produced and show it in the thread's
   * browser tab.
   */
  setDesignPreviewExecutor(executor: DesignCapabilityExecutor | null): void {
    this.host.designPreviewExecutor = executor
  }

  /**
   * Register the executor behind the design capability's `delegate` operation,
   * which runs one prompt on the model the user assigned to a piece of design
   * work. The chat engine supplies it because it owns drivers, accounts and the
   * resolved project path, and because the assignment is a user decision the
   * app must never make on the agent's behalf.
   */
  setDesignAssignmentExecutor(executor: DesignCapabilityExecutor | null): void {
    this.host.designAssignmentExecutor = executor
  }

  /**
   * Register the executor behind the design capability's `save-media`
   * operation, which writes a generated image, video or sound file into the
   * project so the design references a file rather than a link that expires.
   * The app supplies it because it owns the project root the file lands in.
   */
  setDesignMediaExecutor(executor: DesignCapabilityExecutor | null): void {
    this.host.designMediaExecutor = executor
  }

  /**
   * Register the executor behind the `generate` operation the design and video
   * capabilities share, which runs the model the user assigned to a media craft
   * and saves the result into the project. The app supplies it because it owns
   * the provider credential, the vault and the folder the file lands in, and
   * because the model is a user decision the agent must never make.
   */
  setMediaGenerationExecutor(executor: DesignCapabilityExecutor | null): void {
    this.host.mediaGenerationExecutor = executor
  }

  /**
   * Register the executor behind the video capability's `preview` operation,
   * which serves a composition folder on the app's loopback origin and shows it
   * in the thread's browser tab. The app supplies it because it owns the preview
   * server and the browser.
   */
  setVideoPreviewExecutor(executor: VideoCapabilityExecutor | null): void {
    this.host.videoPreviewExecutor = executor
  }

  /**
   * Register the executor behind the video capability's `capture` operation,
   * which freezes the composition at a second and hands the frame back as a
   * picture. The app supplies it because rendering and capturing a frame is a
   * browser operation the agent has no other way to reach.
   */
  setVideoCaptureExecutor(executor: VideoCapabilityExecutor | null): void {
    this.host.videoCaptureExecutor = executor
  }

  /**
   * Register the executor behind the app-owned `cio_ask_secret` gateway tool.
   * Secret collection is an app capability rather than a utility operation: the
   * agent asks, the user pastes into the card, and the value never travels back
   * through the tool result. The chat engine supplies the executor because it
   * owns pending questions, the vault and the utility registry.
   */
  setSecretRequestExecutor(executor: SecretRequestExecutor | null): void {
    this.host.secretRequestExecutor = executor
  }

  /**
   * Register the executor behind the app-owned orchestration tools. Reading the
   * workstation and dispatching real work on a chosen machine are app
   * capabilities: the executor owns the Oven registry, the account registry and
   * the thread a dispatch creates. The chat engine supplies it because it owns
   * all three.
   */
  setOrchestrationExecutor(executor: OrchestrationExecutor | null): void {
    this.host.orchestrationExecutor = executor
  }

  /**
   * Register the executor behind the app-control tools. Driving the app's own
   * rails, panels and settings is an app capability: the executor owns the IPC
   * surface and the renderer bridge. The chat engine supplies it.
   */
  setAppControlExecutor(executor: AppControlExecutor | null): void {
    this.host.appControlExecutor = executor
  }

  /**
   * Register the executor behind the engineering artifact tools. Creating the
   * thread's Brainstorm, PRD, specification or Assignment is an app capability:
   * the executor owns the engines, the isolated generation sessions and the
   * review surfaces. The chat engine supplies it because it owns all of them.
   */
  setEngineeringExecutor(executor: EngineeringToolExecutor | null): void {
    this.host.engineeringExecutor = executor
  }

  /**
   * Register the executor that spawns and continues pawn agents. The chat engine
   * supplies it because it owns thread creation and turn completion.
   */
  setPawnExecutor(executor: PawnToolExecutor | null): void {
    this.host.pawnExecutor = executor
  }

  /**
   * Register a listener invoked for every computer-use operation an agent
   * performs. The listener sees the whole picture, including desktop-scoped
   * operations that name no pid: the PiP monitor needs a pid to track a window,
   * while a thread row only needs to know the thread is using the computer.
   */
  onCuaActivity(listener: (event: CuaOperationEvent) => void): void {
    this.host.cuaActivityListener = listener
  }

  async designPlaybook(threadId: string): Promise<string> {
    const config = await this.host.storage.getConfig()
    const work = await this.host.units['orchestration'].workContext(threadId)
    return (
      work.note +
      designCapabilityDocs(
        prototypeCdnPolicyFromConfig(config),
        await this.host.units['orchestration'].expertsForThread(threadId),
        work.roots
      )
    )
  }

  /**
   * The video capability's playbook. The craft notes are a constant; the experts
   * paragraph is the thread's, because a composition is staffed by the same
   * models a design is.
   */
  async videoPlaybook(threadId: string): Promise<string> {
    const work = await this.host.units['orchestration'].workContext(threadId)
    return (
      work.note +
      videoCapabilityDocs(
        await this.host.units['orchestration'].expertsForThread(threadId),
        work.roots
      )
    )
  }

  /** The remembered snapshot of the window one call names. */
  cuaViewFor(state: TurnState, input: Record<string, unknown>): CuaSnapshotView | null {
    const pid = typeof input['pid'] === 'number' ? input['pid'] : null
    const windowId = typeof input['window_id'] === 'number' ? input['window_id'] : null
    if (pid === null) return null
    if (windowId !== null) return state.cuaViews.get(cuaViewKey(pid, windowId)) ?? null
    // A pid with exactly one remembered window answers for it; a pid with
    // several would be a guess about which window the address meant.
    const views = [...state.cuaViews.values()].filter((view) => view.pid === pid)
    return views.length === 1 ? views[0] : null
  }

  /** The window one call addresses, from the call itself or, when it names only
   *  a pid, from the single window remembered for that pid. */
  cuaActionWindow(
    state: TurnState,
    input: Record<string, unknown>
  ): { pid: number; windowId: number } | null {
    const pid = typeof input['pid'] === 'number' ? input['pid'] : null
    const windowId = typeof input['window_id'] === 'number' ? input['window_id'] : null
    if (pid !== null && windowId !== null) return { pid, windowId }
    if (pid === null) return null
    const views = [...state.cuaViews.values()].filter((view) => view.pid === pid)
    return views.length === 1 ? { pid, windowId: views[0].windowId } : null
  }
}
