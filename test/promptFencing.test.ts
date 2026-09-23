/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { FENCE_OPEN, UNTRUSTED_PREAMBLE, fence, scrubIdentifiers } from "../src/domain/aiPolicy";

// A fenced prompt carries the sentence that says what the fence means, and the text inside it is scrubbed.
//
// `fence()` only writes delimiters. `UNTRUSTED_PREAMBLE` is the sentence that tells the model those
// delimiters mark data it must never take instructions from - so a prompt that fences without it has marked
// the untrusted half and said nothing about it, which is the failure `services/moderation.ts:258-267`
// documents from the other direction ("the preamble pointed at a delimiter that was nowhere in the prompt").
// Neither half is expressible in a type: both are strings, and a call site that forgets one compiles.
//
// TWO SITES FAILED THIS WHEN IT WAS WRITTEN - `attention.summary` fenced goal and card titles under a system
// prompt with no preamble and no scrub, and `goals.measure` did the same with a goal's own description. Both
// are among the least-exercised generation paths in the layer, which is why a scan is the right guard: an
// assertion inside `aiGenerate` only fires on a path somebody runs.
//
// This is the convention `domain/aiPolicy.ts` states as universal, and the codebase already holds unwritable
// conventions this way (`goalStateDrift`, the colour-token ledger, `scopedVerbDrift`).
const sources = import.meta.glob("../src/{services,domain}/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** The text of a call to `name(`, from the opening paren to the one that closes it. */
function callsTo(src: string, name: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  const re = new RegExp(`\\b${name}\\(`, "g");
  for (const m of src.matchAll(re)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    out.push({ text: src.slice(m.index!, i + 1), at: m.index! });
  }
  return out;
}

/** The body of a top-level `const NAME =` or `function NAME(`, wherever in `src/` it is declared. */
function definitionOf(name: string): string {
  for (const src of Object.values(sources)) {
    const m = src.match(new RegExp(`^(?:export )?(?:const|function|async function) ${name}\\b`, "m"));
    if (!m) continue;
    const after = src.slice(m.index! + m[0].length);
    const next = after.search(/^(?:export )?(?:const|function|async function|type|interface|class) /m);
    return after.slice(0, next < 0 ? after.length : next);
  }
  return "";
}

/**
 * A prompt as the model will see it: the call text, plus the bodies of the helpers its `system` and `user`
 * halves are built from.
 *
 * The indirection is the norm rather than the exception - `draftSystem(kind)`, `systemFor(allowed)`,
 * `MEASURE_SYSTEM` - so a scan that read only the call site would pass every one of them without looking at
 * a single prompt.
 */
function promptTextOf(call: string): string {
  const parts = [call];
  for (const line of call.split("\n")) {
    if (!/^\s*(system|user):/.test(line)) continue;
    for (const id of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      if (["system", "user", "fence", "scrubIdentifiers", "scrubStatutoryIds"].includes(id[1]!)) continue;
      parts.push(definitionOf(id[1]!));
    }
  }
  return parts.join("\n");
}

type Site = { file: string; line: number; fenced: boolean; preamble: boolean; scrubbed: boolean };

function generationSites(): Site[] {
  const out: Site[] = [];
  for (const [path, src] of Object.entries(sources)) {
    for (const call of callsTo(src, "aiGenerate")) {
      const text = promptTextOf(call.text);
      out.push({
        file: path.replace(/^\.\.\/src\//, ""),
        line: src.slice(0, call.at).split("\n").length,
        fenced: /\bfence\(|FENCE_OPEN/.test(text),
        preamble: text.includes("UNTRUSTED_PREAMBLE"),
        scrubbed: /\bscrub(Identifiers|StatutoryIds)\(/.test(text),
      });
    }
  }
  return out;
}

describe("prompts that carry untrusted text", () => {
  it("finds the generation call sites", () => {
    // A rename of `aiGenerate` would otherwise leave this passing over nothing.
    const sites = generationSites();
    expect(sites.length).toBeGreaterThan(8);
    expect(sites.filter((s) => s.fenced).length).toBeGreaterThan(4);
  });

  it("carries the preamble wherever it fences", () => {
    const missing = generationSites().filter((s) => s.fenced && !s.preamble).map((s) => `${s.file}:${s.line}`);
    // Add `UNTRUSTED_PREAMBLE` to the system half (or to the user half, as the moderation pass does).
    expect(missing).toEqual([]);
  });

  it("scrubs what it fences", () => {
    const missing = generationSites().filter((s) => s.fenced && !s.scrubbed).map((s) => `${s.file}:${s.line}`);
    // `scrubIdentifiers` for ordinary free text; `scrubStatutoryIds` where a long digit run is the field
    // being read (an invoice number, a phone number) and the general scrub would delete the answer.
    expect(missing).toEqual([]);
  });

  it("does not claim a preamble a prompt does not carry", () => {
    // The scan is only worth its two assertions if the negative case can still be expressed: a fenced prompt
    // with neither property must be visible to it.
    const bare = `aiGenerate(deps, ctx, { system: "be brief", user: fence("the post", text) })`;
    const text = promptTextOf(bare);
    expect(/\bfence\(/.test(text)).toBe(true);
    expect(text.includes("UNTRUSTED_PREAMBLE")).toBe(false);
  });

  it("names the delimiters the preamble describes", () => {
    // The two halves are only one guard while they agree: a fence whose delimiter is not the one the sentence
    // names is the bug this file's header quotes from the moderation pass.
    expect(UNTRUSTED_PREAMBLE).toContain(FENCE_OPEN);
    expect(fence("the post", "hello")).toContain(FENCE_OPEN);
    // And the scrub is a net under the denylist, not a spell-check: it has to actually remove one.
    expect(scrubIdentifiers("pan ABCDE1234F please")).not.toContain("ABCDE1234F");
  });
});
