/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Gate on the session-replay code split.
//
// The recorder is 39.9 kB gz - 11% of everything the browser fetched before the app could render - and it is
// kept off the critical path by three things that have to hold TOGETHER:
//
//   1. web/vite.config.ts gives "@sentry/replay" a chunk of its own, ahead of the blanket "@sentry" rule that
//      would otherwise sweep it into the eager `sentry` chunk;
//   2. web/src/sentryReplay.ts is the dynamic-import boundary, and carries real function bodies - a version
//      that only re-exported from "@sentry/react" was a transparent facade that Rollup resolved straight
//      through, leaving the entry statically importing the recorder anyway;
//   3. web/src/instrument.ts reaches the recorder ONLY through that dynamic import - a single static
//      `Sentry.replayIntegration(...)` or `Sentry.getReplay()` re-pins the whole chunk to the entry.
//
// Break any one and the build still succeeds, the app still works, replay still records, and 39.9 kB quietly
// returns to the critical path with nothing to say so. That is what this test is for. It reads sources as
// text rather than measuring a build, because building here would cost more than the gate is worth; each
// check is aimed at the specific edit that would undo the split.
const viteConfig = import.meta.glob("../web/vite.config.ts", { query: "?raw", import: "default", eager: true })[
  "../web/vite.config.ts"
] as string;
const instrument = import.meta.glob("../web/src/instrument.ts", { query: "?raw", import: "default", eager: true })[
  "../web/src/instrument.ts"
] as string;
const boundary = import.meta.glob("../web/src/sentryReplay.ts", { query: "?raw", import: "default", eager: true })[
  "../web/src/sentryReplay.ts"
] as string;

// These files DOCUMENT the patterns they must not contain - sentryReplay.ts's own header says "no bare
// `export { x } from ...` here" - so the checks below have to look at code, not prose. Whole comment lines are
// dropped; nothing is stripped mid-line, because instrument.ts holds a `https://` inside a template string
// that a naive `//` strip would cut the rest of the line off.
const codeOnly = (src: string): string =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const instrumentCode = codeOnly(instrument);
const boundaryCode = codeOnly(boundary);

describe("the session-replay recorder stays off the critical path", () => {
  it("parses all three files (a silent parse failure would pass every assertion below)", () => {
    expect(viteConfig, "web/vite.config.ts").toMatch(/manualChunks/);
    expect(instrument, "web/src/instrument.ts").toMatch(/Sentry\.init/);
    expect(boundary, "web/src/sentryReplay.ts").toMatch(/replayIntegration/);
  });

  it("gives @sentry/replay its own chunk, before the blanket @sentry rule", () => {
    const replayRule = viteConfig.indexOf('id.includes("@sentry/replay")');
    const blanketRule = viteConfig.indexOf('id.includes("@sentry")) return "sentry"');
    expect(replayRule, 'no "@sentry/replay" chunk rule in web/vite.config.ts').toBeGreaterThan(-1);
    expect(blanketRule, 'no "@sentry" chunk rule in web/vite.config.ts').toBeGreaterThan(-1);
    expect(replayRule, "the @sentry/replay rule must come FIRST or the blanket rule swallows it").toBeLessThan(blanketRule);
  });

  it("reaches the recorder only through a dynamic import", () => {
    expect(instrumentCode, "instrument.ts must import the boundary dynamically").toMatch(/import\("\.\/sentryReplay"\)/);
    // A static import of the boundary would defeat the whole thing.
    expect(instrumentCode, "instrument.ts must not import ./sentryReplay statically").not.toMatch(
      /^import\s[^;\n]*from "\.\/sentryReplay"/m,
    );
  });

  it("holds no static reference to the recorder's own exports", () => {
    // Either of these pulls @sentry/replay back into the eagerly-loaded chunk through the namespace import.
    expect(instrumentCode, "Sentry.replayIntegration must not be referenced statically").not.toMatch(/Sentry\.replayIntegration/);
    expect(instrumentCode, "Sentry.getReplay must not be referenced statically").not.toMatch(/Sentry\.getReplay/);
  });

  it("keeps the boundary module from collapsing into a re-export facade", () => {
    // The failure this guards is subtle: `export { replayIntegration } from "@sentry/react"` builds fine, the
    // chunk list still looks split, and index.html gets the modulepreload back.
    expect(boundaryCode, "sentryReplay.ts must not re-export straight from @sentry/react").not.toMatch(
      /export\s*\{[^}]*\}\s*from\s*"@sentry\/react"/,
    );
    expect(boundaryCode, "sentryReplay.ts must define real functions, not just re-bind imports").toMatch(
      /export function \w+\([\s\S]*?\}/,
    );
  });
});
