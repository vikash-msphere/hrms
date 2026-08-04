import { mkdirSync } from "node:fs";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// The workers pool boots Miniflare from wrangler.toml, and wrangler validates `[assets].directory` even
// though tests serve no static assets. On a fresh clone (CI, before `npm run build:web`) web/dist does not
// exist yet and the whole suite fails to start, so make sure the directory is there.
mkdirSync("web/dist", { recursive: true });

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // Test-only stand-ins for the runtime secrets that `makeDeps` requires (src/deps.ts asserts them so a
        // misconfigured deploy fails fast). Real values are Worker secrets (`wrangler secret put`) and NEVER
        // live in the repo; locally they come from .dev.vars, which CI does not have. These placeholders keep
        // the suite self-contained: no outbound email is sent in tests (the sender is never invoked against a
        // live provider), and dev-auth is the mode the suite already drives, so no CF Access config is needed.
        miniflare: {
          bindings: {
            EMAIL_API_KEY: "test-email-key",
            DEV_FAKE_EMAIL: "dev@example.com",
            ALLOW_DEV_AUTH: "true",
            // All-zero 32-byte keys: valid shape for the assertions + Web Crypto, worthless as secrets.
            // Individual suites still override these with their own values where a test needs to.
            FIELD_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            WIRE_ID_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            AUTH_SESSION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        },
      },
    },
  },
});
