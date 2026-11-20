import { invoke } from '$lib/ipc.svelte'
import { ovens } from '$lib/stores/ovens.svelte'
import { harnessDisplayName } from '../../threads/thread-message-presentation'
import type { ChatComposer } from './ChatComposer-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'

/**
 * The send held while the Oven has to be prepared for it.
 *
 * The composer still owns the message: nothing is cleared at park time, so the
 * text and every attachment stay exactly where the user left them and Cancel is
 * only a matter of dropping the flag. All the send itself needs back is whether
 * it was made direct, since the rest is read from the composer at dispatch.
 */
interface ParkedOvenSend {
  direct: boolean
}

/**
 * A remote Oven that does not have the chosen harness installed is prepared
 * rather than refused: this unit parks the send, the card says what will be
 * installed and cloned, and proceeding dispatches the same turn.
 */
export class ChatComposerOvenSetup extends BoardUnit<ChatComposer> {
  constructor(root: ChatComposer) {
    super(root)
  }

  /** The send the card is standing on, or null when no send is held. */
  private parked = $state<ParkedOvenSend | null>(null)

  /**
   * True while the card is on screen.
   *
   * It needs both halves: a held send, and a harness the Oven still cannot run.
   * Picking a harness the Oven already has through the card's own picker settles
   * the second half, so the card steps out of the way and leaves the draft in
   * the composer without dispatching anything.
   */
  open = $derived(this.parked !== null && this.root.handleDropData.ovenModelUnavailable)

  /** The harness the Oven will be given, named as the rest of the app names it. */
  harnessName = $derived(harnessDisplayName(this.root.handleDropData.resolved.harnessId))

  /** The Oven that will be prepared, by its own name when the registry has one. */
  ovenName = $derived.by(() => {
    const ovenId = this.root.handleDropData.targetOvenId
    if (!ovenId) return 'this Oven'
    return ovens.identity(ovenId)?.name ?? 'this Oven'
  })

  /** The project whose checkout the Oven clones, once it is known. */
  projectName = $state('')

  /** Hold the send on the setup card, keeping its draft in the composer. */
  park(direct: boolean): void {
    this.parked = { direct }
    void this.readProjectName()
  }

  /** Drop a held send without dispatching it. The draft is untouched. */
  cancel(): void {
    this.parked = null
    this.root.submit.focusComposerAtSavedCaret()
  }

  /** Let the turn through, so main installs, clones and runs it. */
  proceed(): void {
    const parked = this.parked
    if (!parked) return
    this.parked = null
    this.root.submit.performSend(parked.direct, true)
  }

  /** Drop the held send once a turn dispatches past the card. */
  clear(): void {
    this.parked = null
  }

  /**
   * Read the checkout's name so the card can say what it clones.
   *
   * A chat carries no project, and a project read can fail, so the card names
   * the checkout as the project it is when it can and stays generic when it
   * cannot: the work is the same either way.
   */
  private async readProjectName(): Promise<void> {
    const projectId = this.root.props.projectId
    if (!projectId || this.projectName !== '') return
    try {
      const project = await invoke('project:get', projectId)
      if (this.parked === null) return
      this.projectName = project?.name ?? ''
    } catch {
      // A failed read only costs the card the checkout's name, not the work.
    }
  }
}
