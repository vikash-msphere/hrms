/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Buttons hand their promise to <Button>.
//
// `components/ui/button.tsx` holds a button in its loading state - disabled, spinner in place of the leading
// icon - for as long as the promise its onClick RETURNS is pending. That is what keeps every action from being
// fired twice while its request is in flight, without each page keeping its own `busy` flag. It only works if
// the handler returns the promise: `onClick={() => void save()}` drops it, the button never learns the action
// is running, and a second click sends a second request.
//
// The scan is deliberately blunt: for every `onClick={…}` on a <Button>, the handler's text must not contain
// `void`. Return the promise instead (`() => save()`, or `{ setX(); return save(); }`).
const web = import.meta.glob("../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const stripComments = (src: string) =>
  src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/[^\n]*$/gm, "");

// The handler expression: from `onClick={` to its balancing `}`.
function handlerAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open + 1, i);
  }
  return "";
}

// Every onClick handler written on a <Button>, keyed by file. The element an attribute belongs to is the
// nearest opening tag before it.
function buttonHandlers(): { path: string; handler: string }[] {
  const out: { path: string; handler: string }[] = [];
  for (const [path, raw] of Object.entries(web)) {
    const src = stripComments(raw);
    const tags = [...src.matchAll(/<([A-Za-z][\w.]*)/g)].map((t) => ({ at: t.index ?? 0, name: t[1] }));
    let t = -1;
    for (const m of src.matchAll(/\bonClick=\{/g)) {
      const at = m.index ?? 0;
      while ((tags[t + 1]?.at ?? Infinity) < at) t++;
      if (tags[t]?.name !== "Button") continue;
      out.push({ path: path.replace("../web/src/", ""), handler: handlerAt(src, at + "onClick=".length) });
    }
  }
  return out;
}

// "path: dropped call" prefix -> reason. Each entry is a handler whose promise must NOT drive the button.
const ALLOW: Record<string, string> = {
  // Resolves when the review sheet it opens is committed, so the button would spin behind the sheet for as
  // long as the reader is working in it.
  "pages/ExpenseBudgets.tsx: openRoll(attention.rollable)": "resolves when the sheet it opens is committed",
};

function findings(): string[] {
  return buttonHandlers().flatMap(({ path, handler }) => {
    const dropped = handler.match(/\bvoid\s+([^;]+?\))/);
    return dropped?.[1] ? [`${path}: ${dropped[1].slice(0, 60)}`] : [];
  });
}

describe("buttons hand their promise to <Button>", () => {
  it("no <Button> onClick drops its promise with void", () => {
    const misses = findings().filter((f) => !Object.keys(ALLOW).some((key) => f.startsWith(key)));
    expect(misses, `return the promise so the button shows it is busy:\n${misses.join("\n")}`).toEqual([]);
  });

  it("the scan sees the tree it guards", () => {
    // A scan that matches nothing passes for ever: pin that it really reads Button handlers.
    expect(buttonHandlers().length).toBeGreaterThan(500);
  });

  it("the allowlist has no dead entries", () => {
    const found = findings();
    const dead = Object.keys(ALLOW).filter((key) => !found.some((f) => f.startsWith(key)));
    expect(dead, `allowlisted handlers that no longer drop a promise: ${dead.join(", ")}`).toEqual([]);
  });
});
