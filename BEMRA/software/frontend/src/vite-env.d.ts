/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_LIVE_POLL_MS?: string;
  readonly VITE_CELL_SPREAD_WARN_MV?: string;
  readonly VITE_FRESH_WITHIN_S?: string;
  readonly VITE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
