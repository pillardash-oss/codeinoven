import { ChatComposerSubmit } from './ChatComposer-submit.svelte'
import { ChatComposerHandleDropData } from './ChatComposer-handle-drop-data.svelte'
import { ChatComposerCaptureComposerRoot } from './ChatComposer-capture-composer-root.svelte'
import { ChatComposerClearDropState } from './ChatComposer-clear-drop-state.svelte'
import { ChatComposerHandleDropAnchorChange } from './ChatComposer-handle-drop-anchor-change.svelte'
import { ChatComposerState } from './ChatComposer-state.svelte'
import { ChatComposerEffects } from './ChatComposer-effects.svelte'
import type { ChatComposerSurfaceProps } from './ChatComposer-types'
import { BoardState } from '$lib/components/board-state'
/**
 * The ChatComposer board: one instance per concern, each holding this board.
 *
 * It is built during the component's own setup, so an `$effect` a unit registers
 * is owned by the component and tears down with it. A unit reads the props
 * through this board, so a prop that changes keeps every `$derived` live.
 */
export class ChatComposer extends BoardState<ChatComposerSurfaceProps> {
  readonly submit = new ChatComposerSubmit(this)
  readonly handleDropData = new ChatComposerHandleDropData(this)
  readonly captureComposerRoot = new ChatComposerCaptureComposerRoot(this)
  readonly clearDropState = new ChatComposerClearDropState(this)
  readonly handleDropAnchorChange = new ChatComposerHandleDropAnchorChange(this)
  readonly state = new ChatComposerState(this)
  readonly effects = new ChatComposerEffects(this)
  constructor(readProps: () => ChatComposerSurfaceProps) {
    super(readProps)
    this.submit.bindEditorId()
    // The units are built first, so each one that captures props at birth is
    // asked to after every unit exists and the board can answer.
    this.submit.bind()
    this.handleDropData.bind()
    this.effects.init()
  }
}
/** Build the board from the surface props. */
export function createChatComposer(readProps: () => ChatComposerSurfaceProps): ChatComposer {
  return new ChatComposer(readProps)
}
