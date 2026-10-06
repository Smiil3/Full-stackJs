/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base de l'API (non sensible). Défaut : /api/v1 via le proxy Vite. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
