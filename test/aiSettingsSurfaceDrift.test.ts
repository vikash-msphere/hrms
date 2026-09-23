/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { AI_FEATURES } from "../src/domain/aiPolicy";

// A FEATURE THE SERVER HAS AND THE SETTINGS SCREEN DOES NOT IS A FEATURE NOBODY CAN TURN ON.
//
// That is not hypothetical: `budgets.narrate` shipped declared, routed, tested and dead - it had a default in
// `aiPolicy.ts`, a service behind it and no card on this screen and no key in the client's own list, so the
// only way to reach it was to PATCH the settings blob by hand. It was written, reviewed and merged in that
// state, because nothing anywhere held the four surfaces against each other.
//
// The four, and what each one being wrong costs:
//
//   AI_FEATURES (server)            the list everything else is checked against
//   FEATURES (this screen)          missing = the switch does not exist
//   SUMMARY (this screen)           missing = a row renders with no line saying what it does
//   GROUPS / NESTED (this screen)   missing = the row exists and is never rendered, which is the worst of
//                                   the four: the copy is there, the switch is there, and the page has no
//                                   place to put it
//   AiFeatureKey (client)           missing = the affordance cannot be gated, so it renders and fails
//
// Asserted from SOURCE because the screen is a .tsx in a different build with its own tsconfig, and the
// worker test environment cannot import it. Same approach as `settingsMirrorDrift`.
const web = import.meta.glob("../web/src/**/{AiSettingsTab.tsx,aiFeatures.ts}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const sourceOf = (name: string) => {
  const entry = Object.entries(web).find(([path]) => path.endsWith(name));
  if (!entry) throw new Error(`${name} not found by the scan - has it moved?`);
  return entry[1];
};

const tab = sourceOf("AiSettingsTab.tsx");
const clientKeys = sourceOf("aiFeatures.ts");

/** The body of a top-level `const NAME ... = ...;` declaration, up to the next top-level declaration. */
function block(src: string, name: string): string {
  const start = src.search(new RegExp(`^const ${name}\\b`, "m"));
  expect(start, `${name} not found in AiSettingsTab.tsx`).toBeGreaterThan(-1);
  const after = src.slice(start + 1);
  const next = after.search(/^(?:export )?(?:const|function|type) /m);
  return after.slice(0, next < 0 ? after.length : next);
}

/** Keys of the `FEATURES` copy list: one `key: "<feature>"` per entry. */
const featureCards = [...block(tab, "FEATURES").matchAll(/^\s{4}key: "([^"]+)"/gm)].map((m) => m[1]!);

/** Keys of the `SUMMARY` record, which may be quoted or bare depending on the name. */
const summaries = [...block(tab, "SUMMARY").matchAll(/^\s{2}"?([A-Za-z0-9_.]+)"?:/gm)].map((m) => m[1]!);

/** Every feature the page actually renders: the ones in a group, plus the ones nested inside those. */
const grouped = [...block(tab, "GROUPS").matchAll(/"([a-z][A-Za-z0-9_.]*)"/g)].map((m) => m[1]!);
const nested = [...block(tab, "NESTED").matchAll(/"([a-z][A-Za-z0-9_.]*)"/g)].map((m) => m[1]!);

/** The client's own union, which gates whether an affordance renders at all. */
const clientUnion = [...clientKeys.matchAll(/^\s*\| "([^"]+)"/gm)].map((m) => m[1]!);

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("every AI feature reaches the screen that turns it on", () => {
  it("found all four lists (a rename must fail loudly, not silently pass)", () => {
    expect(featureCards.length).toBeGreaterThan(10);
    expect(summaries.length).toBeGreaterThan(10);
    expect(grouped.length).toBeGreaterThan(10);
    expect(clientUnion.length).toBeGreaterThan(10);
  });

  it("has a card, with copy, for every feature the server declares", () => {
    expect(sorted(featureCards)).toEqual(sorted(AI_FEATURES));
    expect(sorted(summaries)).toEqual(sorted(AI_FEATURES));
  });

  it("renders every card exactly once, in a group or nested under one", () => {
    // The failure this catches is a card that exists and is never drawn: the page iterates GROUPS, not
    // FEATURES, so a feature missing from both lists is invisible with no error anywhere.
    const reachable = [...grouped, ...nested];
    expect(sorted(reachable)).toEqual(sorted(AI_FEATURES));
    const twice = reachable.filter((k, i) => reachable.indexOf(k) !== i);
    expect(twice, `rendered in more than one place: ${twice.join(", ")}`).toEqual([]);
  });

  it("gives the client a key for every feature, so an affordance can be gated", () => {
    expect(sorted(clientUnion)).toEqual(sorted(AI_FEATURES));
  });
});
