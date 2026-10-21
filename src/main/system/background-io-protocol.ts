export type BackgroundIoRequest =
  | { kind: 'list-directory'; root: string; directory: string; relativeDirectory: string }
  | { kind: 'credential-read'; databasePath: string; values: boolean }
  | { kind: 'credential-delete'; databasePath: string; candidates: string[] }
