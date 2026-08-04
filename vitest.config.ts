import { mkdirSync } from "node:fs";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// The workers pool boots Miniflare from wrangler.toml, and wrangler validates `[assets].directory` even
// though tests serve no static assets. On a fresh clone (CI, before `npm run build:web`) web/dist does not
// exist yet and the whole suite fails to start, so make sure the directory is there.
mkdirSync("web/dist", { recursive: true });

export default defineWorkersConfig({
  test: { poolOptions: { workers: { wrangler: { configPath: "./wrangler.toml" } } } },
});
