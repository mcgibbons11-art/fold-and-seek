/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * A Portals dev token, which gives a locally served build a real session on
   * the fenced `dev:` channel namespace. Minted from the account holder's
   * access key and valid eight hours, so it lives in `.env.local` (gitignored)
   * and never in a committed file or a published bundle.
   */
  readonly VITE_PORTALS_DEV_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
