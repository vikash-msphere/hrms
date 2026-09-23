// Lets `node scripts/<name>.ts` run the repo's TypeScript directly, with no separate runner to install.
//
// Node strips types from .ts files on its own, but it does NOT do TypeScript's extensionless module
// resolution: `import { x } from "../src/db/searchDdl"` is ERR_MODULE_NOT_FOUND, because Node wants a real
// filename. The rest of the codebase is bundled by wrangler/vite, which resolve that happily, so the source
// stays extensionless and this hook covers the one case that runs under bare Node.
//
// Usage (see the db:generate script):  node --import ./scripts/tsResolve.mjs scripts/genSearchDdl.ts
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Only relative/absolute specifiers can be TypeScript sources in this repo; bare specifiers are packages.
const isLocal = (s) => s.startsWith("./") || s.startsWith("../") || s.startsWith("/");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!isLocal(specifier) || /\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(specifier, context);
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        const resolved = nextResolve(candidate, context);
        if (existsSync(fileURLToPath(resolved.url))) return resolved;
      } catch {
        // try the next shape
      }
    }
    return nextResolve(specifier, context);
  },
});
