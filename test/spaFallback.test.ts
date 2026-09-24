// The Worker owns the SPA fallback (wrangler.toml sets `not_found_handling = "none"`), so these rules are
// code, not platform behaviour, and they are the kind that break quietly:
//
//   - a missing FILE must 404. The platform's own SPA fallback answers every miss with index.html at 200,
//     which a browser fetching a script reads as "wrong content type" and then CACHES - a service worker
//     poisoned that way stays broken until the user clears their cache by hand.
//   - a miss under a worker-owned prefix must 404. Those are the API and the unauthenticated public pages;
//     answering with the shell turns "feed disabled" or "forged token" into a 200 page.
//   - anything else is a client-side route and must get the shell, or deep links and refreshes 404.
import { describe, expect, it } from "vitest";
import { app, WORKER_OWNED_PREFIXES } from "../src/index";
import type { Bindings } from "../src/env";
import { EDGE_PATHS, globMatches } from "../src/http/assetPaths";
import { LOOKS_LIKE_A_FILE } from "../src/http/staticSite";

// Inlined at build time rather than read with node:fs: these run inside workerd, which has no filesystem.
// Same approach the migration suite uses to pull in its .sql files.
// Both deploy targets, because they are separate files now: production in wrangler.toml, staging in
// wrangler.staging.toml. A prefix added to one and not the other means that route reaches the Worker in one
// environment and is answered by the SPA shell in the other - exactly the difference staging exists to not
// have, and invisible until somebody rehearses a release and the route 404s there alone.
const wranglerConfigs = Object.entries(
  import.meta.glob("../wrangler*.toml", { query: "?raw", import: "default", eager: true }) as Record<string, string>
);

const viteConfig = Object.values(
  import.meta.glob("../web/vite.config.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>
)[0]!;

// Every top-level file in web/public, by name. Not eager and never loaded - only the keys are read.
const publicFiles = Object.keys(import.meta.glob("../web/public/*")).map((p) => p.replace("../web/public", ""));
// Code in the two directories the media tier serves wholesale. Must stay empty - see the test below.
const codeInPublicDirs = Object.keys(import.meta.glob("../web/public/assets/{illustrations,kudos}/**/*.{js,mjs,cjs,css,html}"));

describe("SPA fallback", () => {
  // `run_worker_first` decides which paths the session gate (src/http/staticSite.ts) sees at all: `/*`, minus
  // one `!` rule per media pattern. A pattern in the file that is not in EDGE_PATHS - or the other way round -
  // is a file served to anyone that the code thinks is gated, or media the WAF rule never covers.
  it("run_worker_first is `/*` plus exactly EDGE_PATHS, in every wrangler config", () => {
    // Two files are expected. One means the staging config was deleted or renamed and this gate quietly
    // stopped covering it, which is the failure mode a `for` loop over whatever matched cannot report.
    expect(wranglerConfigs.map(([path]) => path).sort()).toEqual(
      ["../wrangler.staging.toml", "../wrangler.toml"],
    );
    for (const [path, toml] of wranglerConfigs) {
      const matches = [...toml.matchAll(/^\s*run_worker_first\s*=\s*\[([^\]]*)\]/gm)];
      expect(matches.length, path).toBe(1); // zero would prove nothing; two means TOML would refuse the file
      const rules = [...matches[0]![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      expect(rules, path).toEqual(["/*", ...EDGE_PATHS.map((p) => `!${p}`)]);
    }
  });

  // With preview URLs on, every uploaded version stays reachable at its own address - and the builds from before
  // the gate serve the whole bundle to anyone. Unset is not "off": it is whatever the dashboard last held.
  it("turns preview URLs off in every wrangler config", () => {
    for (const [path, toml] of wranglerConfigs) {
      expect(toml.match(/^\s*preview_urls\s*=\s*(\S+)/m)?.[1], path).toBe("false");
    }
  });

  // The media tier skips the session check, so a pattern that happens to match app code ungates that code. The
  // names below are the shapes Vite emits (web/vite.config.ts manualChunks), including the pdf.js worker chunk.
  it("no media pattern matches app code, apart from the two scripts it names on purpose", () => {
    const code = [
      "/assets/index-DRYsST8K.js",
      "/assets/shell-CK1aC77S.js",
      "/assets/pdfjs-Bx81kQ2a.js",
      "/assets/pdf.worker.min-Aq19xZ0p.mjs",
      "/assets/index-jOdr4N1x.css",
      "/index.html",
      "/",
      "/leave/123",
    ];
    for (const path of code) {
      for (const pattern of EDGE_PATHS) expect(globMatches(pattern, path), `${pattern} vs ${path}`).toBe(false);
    }
    const deliberate = EDGE_PATHS.filter((p) => /\.(m?js|css)$/.test(p));
    expect(deliberate.sort()).toEqual(["/push-sw.js", "/theme-init.js"]);
  });

  // illustrations/ and kudos/ are ungated as whole directories, so a script or stylesheet that landed in one
  // would be served to anyone - the one way code could slip past the pattern check above.
  it("keeps code out of the directories the media tier serves wholesale", () => {
    expect(codeInPublicDirs).toEqual([]);
  });

  // A new file in web/public is served to anyone the moment it matches a media pattern, and gated otherwise -
  // either can be wrong, so each one is a decision. `manifest.webmanifest` is generated by the build (a Vite
  // plugin), so it has no file here; the rest must exist, or a pattern is guarding nothing.
  it("accounts for every top-level public file, and every exact media path exists", () => {
    const unpublished = ["/_headers", "/.assetsignore", "/icon-maskable.svg"]; // consumed by the platform / listed in .assetsignore
    for (const file of publicFiles) {
      if (unpublished.includes(file) || file === "/assets") continue;
      expect(EDGE_PATHS.some((p) => globMatches(p, file)), `${file} is neither media nor listed as unpublished`).toBe(true);
    }
    for (const exact of EDGE_PATHS.filter((p) => !p.includes("*"))) {
      if (exact === "/manifest.webmanifest") continue;
      expect(publicFiles, exact).toContain(exact);
    }
  });

  // The THIRD list. A worker-owned path has to be named in three places that cannot see each other:
  // run_worker_first (so Cloudflare's asset layer does not answer it), WORKER_OWNED_PREFIXES (so a miss under
  // it 404s instead of serving the shell), and the Vite dev proxy (so it reaches the Worker at all in local
  // development). The first two already had this guard; the third did not, and adding /diag without it meant
  // the route worked in production and 404'd on every developer's machine - the SPA's own index.html
  // answering a POST, which looks exactly like the route not existing.
  it("the Vite dev proxy forwards every worker-owned prefix", () => {
    // Underscores are part of the character class because a worker-owned prefix can carry one: wrangler's
    // own `/__scheduled` is the case in point. Without them this regex simply stopped matching, and the
    // failure was "expected null not to be null" - the gate going blind rather than reporting a mismatch,
    // which is the worse of the two ways for a drift test to break.
    const alternation = viteConfig.match(/\^\/\(([a-z_|]+)\)\(\/\|\$\)/);
    expect(alternation).not.toBeNull();
    const proxied = alternation![1]!.split("|").map((p) => `/${p}`);
    // /v1 is excluded here on purpose: it has its own two proxy entries above (Prism, plus the binary custom
    // methods that must bypass it), so it is never part of this alternation.
    expect(proxied.sort()).toEqual(WORKER_OWNED_PREFIXES.filter((p) => p !== "/v1").sort());
  });

  // Guards the classification itself. The regex has to catch a hashed asset without catching an app route
  // that merely contains a dot-free word, so both directions are pinned.
  it("tells a file request apart from a client-side route", () => {
    const looksLikeAFile = (p: string) => LOOKS_LIKE_A_FILE.test(p);

    for (const p of ["/push-sw.js", "/assets/index-DRYsST8K.js", "/assets/a.css", "/favicon.svg", "/manifest.webmanifest", "/assets/pdfjs/wasm/jbig2.wasm"]) {
      expect(looksLikeAFile(p), p).toBe(true);
    }
    for (const p of ["/", "/notifications", "/employees/123", "/payroll/runs/abc", "/settings/notification-prefs"]) {
      expect(looksLikeAFile(p), p).toBe(false);
    }
  });

  it("treats worker-owned prefixes as owned, and app routes as not", () => {
    const owned = (path: string) => WORKER_OWNED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

    expect(owned("/v1/employees")).toBe(true);
    expect(owned("/calendar/holidays/tok")).toBe(true); // the case that regressed: a disabled feed must 404
    expect(owned("/found/abc")).toBe(true);
    expect(owned("/auth/login")).toBe(true);
    expect(owned("/esign/callback")).toBe(true);

    // A prefix must match on a segment boundary, never as a bare string prefix, or an app route that merely
    // starts with the same letters would be misrouted into a 404.
    expect(owned("/v1beta/x")).toBe(false);
    expect(owned("/calendars")).toBe(false);
    expect(owned("/notifications")).toBe(false);
  });

  // The shell's OWN status, not a hardcoded 200. A client-side route is answered by fetching index.html
  // through the ASSETS binding, and that fetch can fail - the file missing after a bad build, the asset layer
  // unwell. Returning 200 around whatever came back is how an error page becomes a "healthy" app route to
  // every monitor, crawler and browser cache that sees it.
  // Signed in through the local dev bypass: the shell is gated now (test/staticSite.test.ts covers the gate
  // itself). The route is not a file, so the store is asked for the path first and then for the shell - a store
  // that answers every request with the same response serves both.
  const dispatch = (path: string, shell: Response) =>
    app.fetch(new Request(`https://hrms.example.com${path}`), {
      ASSETS: { fetch: async () => shell },
      DEV_FAKE_EMAIL: "dev@example.com",
      ALLOW_DEV_AUTH: "true",
    } as unknown as Bindings);

  it("serves a client-side route with the shell, at the shell's status", async () => {
    const ok = await dispatch("/notifications", new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html" } }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("<!doctype html>");
  });

  it("passes a failed shell fetch through instead of dressing it as a 200", async () => {
    const missing = await dispatch("/notifications", new Response("not found", { status: 404 }));
    expect(missing.status).toBe(404);
    const broken = await dispatch("/notifications", new Response("bad gateway", { status: 502 }));
    expect(broken.status).toBe(502);
  });
});
