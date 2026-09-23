/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_ORG?: string;
  /** "1" turns Sentry on for a DEV server, where it is otherwise off (see instrument.ts). */
  readonly VITE_SENTRY_IN_DEV?: string;
  readonly VITE_APP_VERSION?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
