/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The backend origin for a native build. Absent in dev, where `/api` proxies. */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
