/** Dark Reader's packaged Chromium identity and temporary per-tab controls. */
export const DARK_READER_EXTENSION_ID = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'

export type DarkReaderTabAction = 'only-tab' | 'disable-tab' | 'enable-tab' | 'reset-tabs'

export interface DarkReaderTabState {
  supported: boolean
  enabled: boolean
  scoped: boolean
}
