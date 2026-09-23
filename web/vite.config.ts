import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { fileURLToPath, URL } from "node:url";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { ClientRequest } from "node:http";
import { execFileSync } from "node:child_process";

/**
 * The release this build reports itself as.
 *
 * WHY IT IS DERIVED RATHER THAN REQUIRED. `VITE_APP_VERSION` is what the bundle stamps on every error it
 * reports (web/src/instrument.ts) and what the source maps are uploaded against, so the two halves of a trace
 * only meet when it is set - and it is a value CI has to remember to export. It was not set, which is the one
 * failure mode that looks answered: every issue arrives tagged "unknown release", the maps match nothing, and
 * the first production stack trace is minified with no explanation.
 *
 * The commit is the honest answer and the machine already knows it, so an unset variable falls back to the
 * short SHA rather than to nothing. `git` may be absent (a container build off a tarball) and the tree may be
 * dirty; both are reported rather than guessed at, and an explicit VITE_APP_VERSION always wins.
 */
function resolveAppVersion(): string | undefined {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION;
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!sha) return undefined;
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return undefined; // no git, no commit: preflight's warning stands rather than a made-up version shipping
  }
}

const APP_VERSION = resolveAppVersion();

// Emit the PWA manifest at build/serve time so its name follows VITE_APP_NAME (public/ files are copied
// verbatim - a static manifest there could not carry the configured app name).
function pwaManifest(mode: string): Plugin {
  const env = loadEnv(mode, fileURLToPath(new URL("./", import.meta.url)), "VITE_");
  const name = env.VITE_APP_NAME || "Meridian";
  const manifest = JSON.stringify(
    {
      name,
      short_name: name,
      description: "HR self-service: leave, payslips, attendance, approvals and more.",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#F7F9FB", // --neutral-50, the app's light page ground
      theme_color: "#1D4C91", // Brand Blue 700 (--primary)
      // An SVG alone is not enough to be installable: Android wants a raster icon of at least 192px, and a
      // separate `maskable` one it may crop to the launcher's shape (see scripts/genIcons.ts, which
      // rasterizes all of these from favicon.svg). Listing the SVG first still lets browsers that prefer
      // vector take it.
      icons: [
        { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    null,
    2
  );
  return {
    name: "pwa-manifest",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifest });
    },
    configureServer(server) {
      server.middlewares.use("/manifest.webmanifest", (_req, res) => {
        res.setHeader("Content-Type", "application/manifest+json");
        res.end(manifest);
      });
    },
  };
}

// Two fixes applied to every @fontsource stylesheet on its way into the bundle. Both exist because the app
// imports the per-SUBSET entrypoints (`inter/latin-400.css`) rather than the bare `inter/400.css` - the bare
// one declares a @font-face for every subset Google ships (cyrillic, greek, vietnamese, devanagari...) and
// Vite emits a file for each, megabytes of faces the app has no copy to render.
//
// 1. Drop the legacy woff fallback. Each rule is `src: url(...woff2) format('woff2'), url(...woff)
//    format('woff')` and Vite resolves BOTH url()s into emitted assets, so the bundle ships a second, larger
//    copy of every face that no woff2-capable browser (i.e. every browser the app supports) ever requests.
// 2. Put back the `unicode-range`. The subset entrypoints omit it - they assume you pick exactly one subset -
//    so importing latin AND latin-ext at one weight yields two identical @font-face rules, the later winning
//    outright. latin-ext holds no ASCII glyphs, so the whole UI would silently drop to the system fallback.
//    The range is copied from the sibling bare `<weight>.css`, which declares every subset with its range, so
//    this stays correct when @fontsource is upgraded instead of pinning Google's ranges by hand.
//
// Both run before vite:css, which is what turns a url() into an emitted asset. That also means a CSS
// `@import` of a @fontsource file is out of reach (Vite inlines those inside its own CSS pipeline) - import
// faces from TS/TSX, never via @import. See web/src/main.tsx.
function fontsourceSubsets(): Plugin {
  const rangeCache = new Map<string, string | undefined>();

  // The subset file opens with `/* inter-latin-ext-400-normal */`; the bare weight file labels each of its
  // @font-face blocks with that same key, followed by the block's unicode-range.
  const unicodeRangeFor = (id: string, code: string): string | undefined => {
    const key = code.match(/\/\*\s*([\w-]+)\s*\*\//)?.[1];
    const weight = id.match(/[\\/][a-z-]+-(\d{3}(?:-italic)?)\.css$/)?.[1];
    if (!key || !weight) return undefined;
    const barePath = resolve(dirname(id), `${weight}.css`);
    if (!rangeCache.has(barePath + key)) {
      let range: string | undefined;
      try {
        const bare = readFileSync(barePath, "utf8");
        const block = bare.slice(bare.indexOf(`/* ${key} */`));
        if (bare.includes(`/* ${key} */`)) range = block.slice(0, block.indexOf("}")).match(/unicode-range:\s*([^;\n]+)/)?.[1]?.trim();
      } catch {
        range = undefined; // no sibling bare file (single-subset family): nothing to disambiguate
      }
      rangeCache.set(barePath + key, range);
    }
    return rangeCache.get(barePath + key);
  };

  return {
    name: "fontsource-subsets",
    enforce: "pre",
    transform(code, id) {
      const path = id.split("?")[0]!;
      if (!path.endsWith(".css") || !path.includes("@fontsource")) return null;
      let out = code.replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, "");
      if (!/unicode-range/.test(out)) {
        const range = unicodeRangeFor(path, out);
        if (range) out = out.replace(/(\n?)\}/, `;\n  unicode-range: ${range};$1}`);
      }
      return { code: out, map: null };
    },
  };
}

// Everything under web/public is copied into the bundle verbatim and uploaded to Cloudflare as a public
// static asset (wrangler.toml [assets]), and macOS drops a .DS_Store into any directory Finder has opened.
// They are gitignored, so they never show up in review - they just quietly ship, serving Finder's directory
// metadata off the production origin. Sweep them out of the output after the publicDir copy.
function dropFinderJunk(): Plugin {
  let outDir = "";
  const sweep = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) sweep(resolve(dir, entry.name));
      else if (entry.name === ".DS_Store") rmSync(resolve(dir, entry.name));
    }
  };
  return {
    name: "drop-finder-junk",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir); // build.outDir stays relative to root, not cwd
    },
    closeBundle() {
      if (existsSync(outDir)) sweep(outDir); // runs after Vite has copied publicDir into the output
    },
  };
}

// Ship pdf.js's sidecar data. pdf.js fetches its image codecs, standard fonts, CMaps and ICC profile at
// runtime rather than bundling them, so these directories have to exist under /assets/pdfjs/ or documents
// render wrong in ways that depend on the document (see the long note in web/src/lib/pdfjs.ts). Copying them
// out of node_modules at build time keeps them matched to the installed pdfjs-dist and keeps ~4 MB of vendor
// binaries out of the repo. Nothing imports these files, so Rollup cannot discover them - the copy is manual.
//
// quickjs-eval.* is deliberately skipped: it is pdf.js's engine for executing JavaScript embedded IN a PDF,
// reachable only through pdf.sandbox.mjs, which this app never imports.
const PDFJS_DATA_DIRS = ["wasm", "standard_fonts", "cmaps", "iccs"];
const PDFJS_SKIP = /^quickjs-eval\./;

function pdfjsData(): Plugin {
  const pkgDir = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
  const copyDir = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (PDFJS_SKIP.test(entry.name)) continue;
      const src = resolve(from, entry.name);
      const dest = resolve(to, entry.name);
      if (entry.isDirectory()) copyDir(src, dest);
      else copyFileSync(src, dest);
    }
  };
  let outDir = "";
  return {
    name: "pdfjs-data",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    // Dev has no copy step: serve the files straight out of node_modules at the same paths the built app uses.
    configureServer(server) {
      server.middlewares.use("/assets/pdfjs", (req, res, next) => {
        const rel = decodeURIComponent((req.url || "").split("?")[0]!).replace(/^\/+/, "");
        const dir = rel.split("/")[0]!;
        // Path containment: only the four known directories, and no traversal out of the package. The
        // trailing separator matters - a bare startsWith would also accept a sibling like `pdfjs-dist-x`.
        const file = resolve(pkgDir, rel);
        if (!PDFJS_DATA_DIRS.includes(dir) || !file.startsWith(pkgDir + sep)) return next();
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      for (const dir of PDFJS_DATA_DIRS) {
        const from = resolve(pkgDir, dir);
        if (existsSync(from)) copyDir(from, resolve(outDir, "assets/pdfjs", dir));
      }
    },
  };
}

// Preload the two UI-font faces that appear on every screen. Without this the browser cannot discover them
// until it has downloaded and parsed the stylesheet that declares the @font-face, so first paint shows the
// system fallback and then reflows. Only latin 400/600 are worth the bandwidth - the other weights and the
// latin-ext subset are genuinely conditional. The filenames carry a content hash, so the tags have to be
// generated from the finished bundle rather than written into index.html by hand.
const PRELOAD_FACES = /(^|\/)inter-latin-(400|600)-normal-[^/]*\.woff2$/;

function preloadUiFont(): Plugin {
  return {
    name: "preload-ui-font",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.bundle) return html; // dev server: nothing is hashed and nothing is slow to discover
        const faces = Object.keys(ctx.bundle).filter((f) => PRELOAD_FACES.test(f));
        return {
          html,
          // `crossorigin` is required even same-origin: fonts are always fetched in CORS mode, and a preload
          // whose mode differs from the real request is discarded and fetched a second time.
          tags: faces.map((f) => ({
            tag: "link",
            attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${f}`, crossorigin: "" },
            injectTo: "head-prepend" as const,
          })),
        };
      },
    },
  };
}

// One chunk per WORKSPACE, not per page. A workspace is a nav entry with tabs (web/src/nav.ts): Team is one
// surface with six tabs, Hiring is one surface with seven, and switching tabs inside one is the commonest
// navigation there is. Splitting each tab into its own 6-18 kB chunk made every tab click a round trip for a
// few kB - all latency, no bandwidth. Grouped, the first page in a workspace costs 30-60 kB gz and every other
// tab in it costs nothing.
//
// Members are page module basenames, and the groups follow NAV's tab lists. A page that is its own nav entry
// (Dashboard, Documents, Compliance, Settings) is not listed and keeps its own chunk, which is also what any
// page added later gets until it is put in a group - the wrong-but-safe default. web/test/chunkGroups.test.ts
// checks this table against NAV so a new tab cannot quietly fall out of its workspace.
const PAGE_GROUPS: Record<string, readonly string[]> = {
  "ws-team": ["Directory", "EmployeeProfile", "OrgChart", "TeamAnalytics", "Onboarding", "NoticePeriods", "BackgroundChecks"],
  "ws-progress": ["Boards", "Goals", "Reviews", "CheckIns"],
  "ws-connect": ["Announcements", "Suggestions", "Events", "Moderation"],
  "ws-hiring": ["Pipeline", "Requisitions", "Candidates", "CandidateProfile", "Interviews", "Offers", "Referrals", "RecruitingAnalytics"],
  "ws-time": ["Attendance", "Schedule", "Timesheets", "Overtime", "RemoteWork", "Delegations"],
  "ws-leave": ["Leaves", "LeaveCalendar", "Holidays"],
  "ws-pay": ["Payslips", "Reimbursements", "Loans", "TaxDeclarations", "Benefits", "PayrollRuns"],
  "ws-expenses": ["Expenses", "Vendors", "ExpenseBudgets", "CardTransactions"],
  "ws-assets": ["Assets", "Stocktakes"],
  // The Home group. Three small pages every session touches; one chunk between them is one request, not three.
  "ws-home": ["Approvals", "Profile", "Notifications"],
  // The Admin nav group. Settings is the hub for ~25 lazy panels and for a dozen admin pages that no nav entry
  // links to (BankFormats, LeaveTypes, PayComponents...) - they are reachable only by opening Settings, so
  // they belong in Settings' chunk rather than in a request each. Those pages are NOT listed here: they are
  // picked up automatically by panelGroup, which sends a lazy module with one lazy parent to that parent's
  // chunk. Only the three nav entries need naming.
  "ws-admin": ["Settings", "Workflows", "Activity"],
};

const PAGE_GROUP_OF = new Map(Object.entries(PAGE_GROUPS).flatMap(([chunk, pages]) => pages.map((p) => [p, chunk] as const)));

const basename = (id: string) => id.split(/[\\/]/).pop()!.replace(/\.tsx?$/, "");

// The workspace chunk for a page module, or undefined for anything that is not a grouped page.
function pageGroup(id: string): string | undefined {
  if (!/[\\/]web[\\/]src[\\/]pages[\\/]/.test(id)) return undefined;
  return PAGE_GROUP_OF.get(basename(id));
}

// How many bytes of source does this module own PRIVATELY - itself plus every static dependency that nothing
// else imports? It is the only way to tell two lazy modules apart that look identical from the outside:
// lib/assetTagsPdf.ts is 5.8 kB of source and SettingsButton's panels are 6-11 kB, but assetTagsPdf privately
// owns jsPDF and renders a 421 kB chunk while a panel renders 6 kB. Source bytes of shared dependencies are
// ignored precisely because they are shared - react, radix and lucide already live in chunks of their own, so
// they cost a grouped module nothing.
const weightCache = new Map<string, number>();

function privateWeight(id: string, getModuleInfo: (id: string) => { importers: readonly string[]; importedIds: readonly string[] } | null): number {
  const cached = weightCache.get(id);
  if (cached !== undefined) return cached;
  let bytes = 0;
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const next = queue.pop()!;
    const info = getModuleInfo(next);
    if (!info) continue;
    try {
      bytes += statSync(next.split("?")[0]!).size;
    } catch {
      // A virtual or generated module has no file on disk; it carries no weight worth counting.
    }
    // importers.length > 1 means some other chunk pulls this in too, so it is not this module's to pay for.
    for (const dep of info.importedIds) if (!seen.has(dep) && getModuleInfo(dep)?.importers.length === 1) { seen.add(dep); queue.push(dep); }
  }
  weightCache.set(id, bytes);
  return bytes;
}

// Panels - the bodies behind Settings' registry switch and the feature-page gear - are lazy modules with
// exactly one lazy parent, and on their own they were ~25 chunks of 4-19 kB, one request per panel opened.
// Send them to their parent's chunk so the first one pays for all of them.
//
// The weight guard is what keeps this from swallowing the deliberate heavy deferrals. A PDF viewer, the tag
// printer and the xlsx exporter are also lazy modules with one parent, and grouping them by shape alone put
// 421 kB of jsPDF into the Assets workspace. Anything that privately owns real vendor weight keeps the
// isolated chunk its call site asked for. The limit sits well above the biggest hand-written panel (ApiKeysPanel,
// 39 kB) and two orders of magnitude below a module that owns a PDF engine, so it needs no precision.
const PANEL_MAX_PRIVATE_SOURCE = 60_000;

function panelGroup(id: string, info: { dynamicImporters: readonly string[] }, getModuleInfo: Parameters<typeof privateWeight>[1]): string | undefined {
  if (info.dynamicImporters.length !== 1) return undefined;
  const parent = info.dynamicImporters[0]!;
  if (!/[\\/]web[\\/]src[\\/]pages[\\/]/.test(parent)) return undefined;
  if (privateWeight(id, getModuleInfo) > PANEL_MAX_PRIVATE_SOURCE) return undefined;
  // A grouped parent takes its panels into the workspace chunk; an ungrouped one gets a `-panels` sidecar so
  // the page itself still loads without them.
  return pageGroup(parent) ?? `${basename(parent)}-panels`;
}

// Does the app shell reach this module without crossing an import()? Walk static importers upwards until an
// entry module turns up; everything else is behind a lazy route. Memoised per build - the walk is over the
// whole module graph and manualChunks asks about every module in it. `seen` also breaks import cycles, which
// the app has plenty of; a cycle that reaches no entry is correctly reported as false.
const shellCache = new Map<string, boolean>();

function reachedByShell(id: string, getModuleInfo: (id: string) => { isEntry: boolean; importers: readonly string[] } | null): boolean {
  const cached = shellCache.get(id);
  if (cached !== undefined) return cached;
  let answer = false;
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length && !answer) {
    const info = getModuleInfo(queue.pop()!);
    if (!info) continue;
    if (info.isEntry) answer = true;
    else for (const importer of info.importers) if (!seen.has(importer)) { seen.add(importer); queue.push(importer); }
  }
  // A false answer means the whole ancestor set was explored and held no entry. The ancestors of anything in
  // that set are themselves in it, so the answer is theirs too. A true answer stopped early and only the
  // module asked about is known to be shell-reachable.
  for (const m of answer ? [id] : seen) shellCache.set(m, answer);
  return answer;
}

// Prism enforces openapi.yaml's `security` itself: a request carrying none of the three schemes is refused at
// the proxy with its own 401 and never reaches the worker. The dev server has no credential to send - the local
// worker authenticates through the DEV_FAKE_EMAIL bypass (src/middleware/auth.ts), so the browser sends no
// Access header, no session cookie and no key - so every /v1 call 401'd, the SPA read that as a lapsed session
// and bounced to /auth/login, and the app never booted through the proxy. Satisfy the Access-JWT scheme with a
// placeholder: the worker's dev bypass is decided before that header is ever read, and a real credential (a
// signed-in session cookie, an Access token, an API key) is left alone.
//
// Never inject the BEARER scheme instead: an `hrms_`-shaped bearer is terminal in the worker's machine lane, so
// a placeholder there would 401 for real rather than fall through to the dev bypass.
//
// The second fix is for Prism's OTHER blanket failure: it forwards the browser's `Accept-Encoding`, workerd
// honours it, and Prism then cannot read the compressed body back - every request dies as
// `{"type":"FetchError","title":"Invalid response body ...: Premature close","status":500}`. curl sends no
// Accept-Encoding by default, which is why the proxy looks healthy from a terminal and fails in a browser.
// Ask the worker for identity encoding instead; over localhost the compression bought nothing anyway.
// Where the dev server sends what it does not serve itself. The defaults are the dev stack's ports
// (scripts/start.sh); the browser-test stack (scripts/e2eStack.sh) runs its own worker and its own Prism on
// different ports so it can never collide with a dev stack somebody has running, and points these at them.
const WORKER_ORIGIN = process.env.HRMS_WORKER_ORIGIN ?? "http://localhost:8787";
const PRISM_ORIGIN = process.env.HRMS_PRISM_ORIGIN ?? "http://localhost:4010";

function prepareForPrism(proxyReq: ClientRequest) {
  proxyReq.setHeader("Accept-Encoding", "identity");
  const cookie = String(proxyReq.getHeader("cookie") ?? "");
  if (proxyReq.getHeader("authorization") || proxyReq.getHeader("cf-access-jwt-assertion") || cookie.includes("hrms_session=")) return;
  proxyReq.setHeader("Cf-Access-Jwt-Assertion", "dev");
}

// This directory (`<repo>/web/`), resolved from the CONFIG FILE rather than from the current working
// directory. `root: "./web"` read correctly only when the build was started from the repo root; started from
// inside `web/` it resolved to `web/web`, and because Rollup runs `closeBundle` even on a FAILED build, the
// entry-not-found error still left 198 pdf.js data files behind in `web/web/dist/assets/pdfjs`. That
// directory is not covered by `.gitignore` (which lists `web/dist`), so a later `git add -A` would have
// committed several megabytes of wasm and font binaries. Absolute, so the config behaves identically
// wherever it is invoked from. `loadEnv` and the `@` alias already resolve this way.
const WEB_ROOT = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => ({
  root: WEB_ROOT,
  // The derived release has to reach the BUNDLE, not just the source-map upload: `instrument.ts` reads
  // `import.meta.env.VITE_APP_VERSION` for the `release` it tags every event with, and Vite only populates
  // that from a .env file or a real environment variable - a value computed in this config is invisible to it.
  // Defined here so the tag the events carry and the release the maps are uploaded against are one string by
  // construction. An explicit VITE_APP_VERSION in the environment still wins (see resolveAppVersion), and
  // when there is no version to be had the key resolves to undefined exactly as before.
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(APP_VERSION),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [
    // The module graph is rebuilt on every build (and on every rebuild under --watch), so the memos keyed to it
    // - shell reachability and private weight - have to go with it.
    { name: "reset-chunk-caches", buildStart() { shellCache.clear(); weightCache.clear(); } } satisfies Plugin,
    fontsourceSubsets(),
    pdfjsData(),
    preloadUiFont(),
    dropFinderJunk(),
    react(),
    pwaManifest(mode),
    // Source maps, uploaded to the error tracker and then DELETED from the build.
    //
    // Without them a production stack trace is `index-a1b2c3.js:1:48213`, which names nothing - every issue
    // this app has ever reported was only readable because it came from the dev server. The maps are built
    // (`sourcemap: "hidden"` below), uploaded here, and removed from web/dist afterwards, so they never ship:
    // a .map served publicly hands the whole unminified source to anyone who asks for it.
    //
    // Only active with SENTRY_AUTH_TOKEN in the environment, which is a CI secret and never committed. A local
    // `npm run build` has no token, skips the plugin entirely, and is unchanged.
    ...(process.env.SENTRY_AUTH_TOKEN
      ? [
          sentryVitePlugin({
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            authToken: process.env.SENTRY_AUTH_TOKEN,
            // The release the maps belong to. MUST match what the bundle reports at runtime
            // (VITE_APP_VERSION -> `release` in web/src/instrument.ts) or the maps are uploaded against a
            // release no event ever claims, and traces stay minified with nothing to explain why.
            release: { name: APP_VERSION },
            // Absolute, for the same reason as `root` above: a cwd-relative glob here deletes nothing when
            // the build is started from anywhere but the repo root, which would leave the unminified source
            // maps sitting in the output to be uploaded to Cloudflare as public assets.
            sourcemaps: { filesToDeleteAfterUpload: [resolve(WEB_ROOT, "dist/**/*.map")] },
          }),
        ]
      : []),
  ],
  build: {
    // Maps are generated ONLY when there is a token to upload them with, and the two conditions are the same
    // expression on purpose. Generating them unconditionally left 30 .map files sitting in web/dist on any
    // build without a token - and web/dist is what gets uploaded to Cloudflare, so a plain `npm run build &&
    // wrangler deploy` would have served the entire unminified source to anyone who asked for it. The plugin's
    // `filesToDeleteAfterUpload` cleans them up, but the plugin only runs when the token is set.
    //
    // "hidden" rather than true: the maps are emitted for the upload but no `//# sourceMappingURL=` comment is
    // written into the bundle, so a browser never goes looking for one.
    sourcemap: process.env.SENTRY_AUTH_TOKEN ? "hidden" : false,
    // Relative to `root`, which is this directory - so plain "dist" is `<repo>/web/dist`. It was
    // "../web/dist", which resolved to the same place but only by leaving the root and coming back into it,
    // and that round trip is what made the doubled `web/web` hard to spot.
    outDir: "dist",
    emptyOutDir: true,
    // Don't emit the inline module-preload polyfill: an inline <script> would force the SPA CSP to allow
    // 'unsafe-inline' scripts. Modern browsers support modulepreload natively, so the polyfill is unneeded.
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // Split the big, rarely-changing vendor libs out of the app entry so the index chunk shrinks and each
        // vendor is cached independently across app deploys. (xlsx / the native PDF path are already isolated
        // via dynamic import() at their call sites.)
        // NOTE: lucide-react is deliberately NOT named here. Forcing it into one "icons" chunk put every icon
        // the app imports anywhere - 198 files, most of them lazy routes - on the critical path, ~26 kB gz of
        // which the shell needs a fraction. Left alone, Rollup hoists only the icons the entry actually shares
        // and lets the rest ride the page chunk that imports them. Same reasoning applies to any other
        // per-icon/per-component library: naming a chunk here is only a win for a lib the ENTRY already pulls
        // in whole, which is what react and radix are and what an icon set is not.
        //
        // The app's own source is grouped by the second half of this function, into `shell` and `shared`.
        manualChunks(id, { getModuleInfo }) {
          if (id.includes("node_modules")) {
            // One stylesheet per decorative typeface. lib/fonts.ts loads a face with ten separate import()s
            // (latin + latin-ext across five weights), and Vite gives every dynamically imported stylesheet an
            // asset of its own - 56 files of ~350 bytes, and ten requests to switch the wordmark to Poppins.
            // Naming a chunk per family puts all ten in one, so Vite emits one stylesheet for the family.
            // Inter is excluded on purpose: it is the UI font, imported statically by main.tsx, and belongs in
            // the entry stylesheet where it is already merged - pulling it out would cost first paint a
            // render-blocking request for the face every screen uses.
            const face = /[\\/]@fontsource[\\/]([\w-]+)[\\/]/.exec(id);
            if (face && face[1] !== "inter" && id.split("?")[0]!.endsWith(".css")) return `font-${face[1]}`;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
            if (id.includes("@radix-ui")) return "radix";
            // Same reasoning as react/radix: instrument.ts is imported by the entry, so the whole SDK is on
            // the critical path whatever we do here - naming it keeps ~92 kB gz of code that changes only
            // when the SDK is upgraded out of the app's own entry chunk, which rehashes every deploy.
            // 41 kB of that is session replay's recorder. It cannot be deferred to a later chunk: replay runs
            // in buffer mode (see instrument.ts), so it has to be recording BEFORE the error it explains, and
            // a dynamic import of @sentry/react would be merged back into this chunk anyway - Rollup inlines a
            // module that is also statically imported.
            // The session-replay recorder, split OUT of the eager `sentry` chunk. Without this line the
            // `@sentry` rule below sweeps it back in and the dynamic import in web/src/sentryReplay.ts buys
            // nothing - the chunk is named, so it is fetched eagerly with the rest of the SDK. Measured:
            // naming it here and importing it dynamically takes 39.9 kB gz off the critical path.
            if (id.includes("@sentry/replay")) return "sentry-replay";
            if (id.includes("@sentry")) return "sentry";
            // pdf.js and the module that exports its worker's URL (`pdf.worker.min.mjs?url`, all of 120 bytes)
            // load at the same moment - the stub is only read to point pdf.js at its worker. One chunk, not two.
            if (id.includes("pdfjs-dist")) return "pdfjs";
            // Naming the remaining lazily-loaded vendors costs nothing and is not cosmetic: each of these
            // otherwise renders as `index-<hash>.js`, and there were three of those in the output at once.
            // Their split points stay exactly where their call sites put them - this only gives them names.
            if (id.includes("@zxing")) return "zxing"; // the stocktake scanner's decoder (lib/scanner.ts)
            if (id.includes("html-to-image")) return "html-to-image"; // org-chart PNG export
            // qrcode's entry file is lib/browser.js, so its chunk was called `browser`. dijkstrajs is its own
            // private dependency and has nowhere else to go.
            if (/[\\/]node_modules[\\/](qrcode|dijkstrajs)[\\/]/.test(id)) return "qrcode";
            return;
          }
          // Every module the app shares between two or more lazy routes is one Rollup chunk of its own,
          // because each has a different set of routes that reach it. That is correct and useless: it turned
          // ~100 lazy pages into 196 chunks, 84 of them under 2 kB (60 kB of code across 84 requests), and
          // opening one page cost up to 36 parallel fetches. Put all of that shared code in ONE chunk that
          // loads with the shell instead - the whole of it is smaller than a single page chunk, and after it
          // every navigation costs one request.
          //
          // A module reached ONLY through a dynamic import() is the split point its call site asked for, so it
          // keeps its own chunk (and takes its static dependencies with it). That is what keeps the deliberate
          // lazy payloads - route pages, the PDF viewers, the tag printer, xlsx - off the critical path; a
          // heavy module that also has a static importer would land in `shared`, so import() it at both sites.
          // Only the app's own source is grouped. Virtual modules (`\0commonjsHelpers.js` and friends) carry no
          // node_modules in their id but belong to the vendor code that imports them - group one into `shell`
          // and react-vendor ends up importing shell, a chunk cycle Rollup warns about.
          if (!/[\\/]web[\\/]src[\\/]/.test(id)) return;
          const info = getModuleInfo(id);
          if (!info || info.isEntry) return;
          // A dynamic-only module is the split point its call site asked for. Two kinds get regrouped anyway:
          // a page joins its workspace (PAGE_GROUPS), and a lightweight panel joins the page that opens it.
          if (info.importers.length === 0) return pageGroup(id) ?? panelGroup(id, info, getModuleInfo);
          // A page is a route payload even when a sibling page happens to import a piece of it (Settings.tsx
          // alone is 192 kB of source). Pages keep their own chunk whatever the import graph says.
          if (/[\\/]web[\\/]src[\\/]pages[\\/]/.test(id)) return pageGroup(id);
          if (info.importers.length < 2 && info.dynamicImporters.length === 0) return; // rides its one importer
          // Two shared chunks, not one. Anything the shell itself reaches through static imports has to be
          // downloaded before first paint whatever chunk it sits in, so it goes in `shell`. The rest is shared
          // only between lazy routes: keeping it separate leaves 265 kB (84 kB gz) out of first paint and costs
          // exactly one request, on the first navigation, cached for every navigation after it.
          return reachedByShell(id, getModuleInfo) ? "shell" : "shared";
        },
      },
    },
  },
  server: {
    proxy: {
      // Binary custom methods go STRAIGHT to the worker: Prism re-encodes a binary body as text, so a PDF
      // arrives with U+FFFD replacement bytes where its binary header/streams were - a corrupt file that
      // downloads as unopenable and renders as a blank PDF viewer. Everything else goes through the Prism
      // contract-validation proxy. Any new verb that returns or accepts raw bytes must be listed here (the
      // route's `c.body(...)` with a non-JSON Content-Type is the tell).
      "^/v1/.*:(getPhoto|uploadPhoto|getSignature|uploadSignature|download|downloadIdentityDoc|uploadIdentityDoc|upload|uploadTemplate|previewLetter|preview|previewPayslip|bankFile|statutoryReport)": WORKER_ORIGIN,
      "/v1": {
        target: PRISM_ORIGIN,
        configure: (proxy) => proxy.on("proxyReq", prepareForPrism),
      },
      // The worker owns more than /v1 (WORKER_OWNED_PREFIXES in src/index.ts), and none of these paths are in
      // openapi.yaml, so they cannot go through Prism. Unproxied they fall through to the SPA's index.html,
      // which turns a sign-in redirect into the app reloading itself.
      // /diag is here for the same reason and for one of its own: it carries COMPRESSED BINARY (a session
      // replay's recording item), so it could not go through Prism even if it were in the contract - Prism
      // re-encodes a binary body as text, which is precisely the corruption the relay itself was just fixed
      // for. Straight to the Worker, bytes intact.
      "^/(auth|esign|found|calendar|diag|__scheduled)(/|$)": WORKER_ORIGIN,
    },
  },
}));
