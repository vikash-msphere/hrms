/// <reference types="vite/client" />

// Playwright specs typecheck against app modules (see e2e/tsconfig.json), and an app module is free to reach
// further into the bundle than the spec meant to pull: importing `web/src/lib/utils` for `cn` also drags in
// orgDay -> settingsStore -> api -> getCoalescer, two of which read `import.meta.env.DEV` to gate a dev-only
// warning. That is a Vite builtin, declared by `vite/client`.
//
// The reference lives here rather than on the specs that happen to import a web module today, because which
// specs those are is a property of the app's import graph, not of the specs: the chain above appeared when
// utils.ts picked up a date helper, with no e2e file changed. `types: ["@playwright/test", "node"]` in
// e2e/tsconfig.json suppresses automatic @types inclusion but not an explicit reference, which is the same
// arrangement web/src/vite-env.d.ts and the test/ specs already use.
