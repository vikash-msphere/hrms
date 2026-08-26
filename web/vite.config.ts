import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

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

export default defineConfig(({ mode }) => ({
  root: "./web",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [fontsourceSubsets(), pdfjsData(), preloadUiFont(), dropFinderJunk(), react(), pwaManifest(mode)],
  build: {
    outDir: "../web/dist",
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
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
          if (id.includes("@radix-ui")) return "radix";
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
      "^/v1/.*:(getPhoto|uploadPhoto|getSignature|uploadSignature|download|downloadIdentityDoc|uploadIdentityDoc|upload|uploadTemplate|previewLetter|preview|previewPayslip|bankFile|statutoryReport)": "http://localhost:8787",
      "/v1": "http://localhost:4010",
    },
  },
}));
