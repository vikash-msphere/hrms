/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Drift gate between the nav's workspaces and the bundler's page groups.
//
// web/vite.config.ts puts the pages of one workspace in one chunk, so switching tabs inside a workspace costs
// no request. That grouping is a hand-written table, and nothing about adding a tab to NAV forces anyone to
// update it - the tab would just quietly become its own 6-18 kB chunk again. This test is the thing that
// forces it: every tab of a multi-tab workspace must render a page that sits in the SAME chunk as its
// siblings.
//
// All three files are read as text rather than imported: vite.config.ts is a build-time module (it imports
// node:fs), and App.tsx/nav.ts pull in the whole component tree. The parsing is deliberately shallow - it
// reads the shapes these files actually have, and a parse that finds nothing fails loudly below.
const viteConfig = import.meta.glob("../web/vite.config.ts", { query: "?raw", import: "default", eager: true })["../web/vite.config.ts"] as string;
const nav = import.meta.glob("../web/src/nav.ts", { query: "?raw", import: "default", eager: true })["../web/src/nav.ts"] as string;
const app = import.meta.glob("../web/src/App.tsx", { query: "?raw", import: "default", eager: true })["../web/src/App.tsx"] as string;
const pageFiles = new Set(
  Object.keys(import.meta.glob("../web/src/pages/*.tsx", { eager: false })).map((p) => p.split("/").pop()!.replace(/\.tsx$/, "")),
);

// "ws-team": ["Directory", "EmployeeProfile", ...] -> chunk name per page module basename.
function parsePageGroups(): Map<string, string> {
  const block = viteConfig.match(/const PAGE_GROUPS[^=]*=\s*\{([\s\S]*?)\n\};/)?.[1] ?? "";
  const groups = new Map<string, string>();
  for (const [, chunk, members] of block.matchAll(/"([\w-]+)":\s*\[([^\]]*)\]/g)) {
    for (const [, page] of members!.matchAll(/"([\w]+)"/g)) groups.set(page!, chunk!);
  }
  return groups;
}

// Every NAV item that carries `tabs: [...]`, as the list of route keys its tabs address.
function parseWorkspaces(): { key: string; tabs: string[] }[] {
  const out: { key: string; tabs: string[] }[] = [];
  for (const m of nav.matchAll(/\{\s*\n\s*key: "([\w-]+)",[\s\S]*?tabs: \[([\s\S]*?)\n\s*\],/g)) {
    const tabs = [...m[2]!.matchAll(/\{ key: "([\w-]+)"/g)].map((t) => t[1]!);
    out.push({ key: m[1]!, tabs });
  }
  return out;
}

// `case "org-chart":` + the JSX on the following lines -> every page component that route key can render.
// A key renders more than one when it has a detail view (`employees` is Directory or EmployeeProfile). A
// block ends at the next `case` or at `default:`, so the last case does not claim the fallback page.
function parseRoutes(): Map<string, string[]> {
  const routes = new Map<string, string[]>();
  for (const m of app.matchAll(/case "([\w-]+)":\n((?:(?!\s*(?:case "|default:))[^\n]*\n)+)/g)) {
    const rendered = [...m[2]!.matchAll(/<([A-Z]\w+)/g)].map((c) => c[1]!).filter((c) => pageFiles.has(c));
    if (rendered.length) routes.set(m[1]!, [...new Set(rendered)]);
  }
  return routes;
}

const pageGroups = parsePageGroups();
const workspaces = parseWorkspaces();
const routes = parseRoutes();

describe("bundler page groups follow the nav workspaces", () => {
  it("parses all three sources", () => {
    expect(pageGroups.size).toBeGreaterThan(20);
    expect(workspaces.length).toBeGreaterThan(5);
    expect(routes.size).toBeGreaterThan(20);
  });

  it("groups only real page modules, each in one chunk", () => {
    const unknown = [...pageGroups.keys()].filter((p) => !pageFiles.has(p));
    // A name that is not a page under web/src/pages is inert: pageGroup() only ever matches page ids, so the
    // entry silently does nothing (this is how AssetCustody, a component, was caught).
    expect(unknown, "PAGE_GROUPS names that are not pages").toEqual([]);
  });

  it("keeps every tab of a workspace in its workspace chunk", () => {
    const drift: string[] = [];
    for (const ws of workspaces) {
      if (ws.tabs.length < 2) continue; // a single-tab entry is just a page; grouping buys it nothing
      const chunks = new Map<string, string | undefined>();
      for (const tab of ws.tabs) {
        for (const page of routes.get(tab) ?? []) chunks.set(page, pageGroups.get(page));
      }
      const distinct = new Set(chunks.values());
      if (distinct.size > 1 || distinct.has(undefined)) {
        drift.push(`${ws.key}: ${[...chunks].map(([page, chunk]) => `${page}->${chunk ?? "UNGROUPED"}`).join(", ")}`);
      }
    }
    expect(drift, "workspace tabs split across chunks - fix PAGE_GROUPS in web/vite.config.ts").toEqual([]);
  });
});
