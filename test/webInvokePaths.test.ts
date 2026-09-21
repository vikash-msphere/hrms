/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
// @ts-expect-error - untyped module, runtime-only (same pattern as openapiRoutesDrift.test.ts)
import { load } from "js-yaml";

// `invoke(path, verb, etag?)` - the THIRD argument is an If-Match header, not an id.
//
// THE BUG THIS EXISTS FOR, found in a browser and not by any other test. An item verb called as
//
//     invoke("cards", "triage", cardId)
//
// reads like "call triage on this card" and is none of those things: it POSTs `/v1/cards:triage`, the
// COLLECTION path, and hands the card's id to the server as an ETag. There is no such route, so the request
// 404s, and every one of these panels swallows its own errors by design - a suggestion panel that shouts at
// somebody who opened a dialog to do something else is worse than one that quietly says nothing. So the
// feature renders its "nothing to say" state for ever, on every board, and looks exactly like a feature with
// nothing to say.
//
// It shipped that way once (`cards:triage`), and every panel written afterwards copied the shape. Nothing
// caught it: tsc is happy (both arguments are strings), the unit suite tests the SERVICE rather than the
// call, and the e2e that would have caught it did not exist yet.
//
// WHAT THIS CHECKS. A bare collection name as the first argument is legal only for a COLLECTION-LEVEL custom
// method - `announcements:markAllRead` has no object to name. openapi.yaml already distinguishes the two by
// its path shape, so that is the source of truth rather than a hand-kept list here.
const webFiles = import.meta.glob("../web/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const rawSpec = import.meta.glob("../openapi.yaml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const spec = load(Object.values(rawSpec)[0]!) as { paths: Record<string, unknown> };

/** `<collection>:<verb>` for every custom method whose path names NO object. */
const collectionLevel = new Set(
  Object.keys(spec.paths)
    .map((p) => /^\/v1\/([a-z0-9-]+):([A-Za-z0-9]+)$/.exec(p))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[1]}:${m[2]}`),
);

/** `<collection>:<verb>` for every custom method whose path DOES name one. */
const itemLevel = new Set(
  Object.keys(spec.paths)
    .map((p) => /^\/v1\/([a-z0-9-]+)\/\{[a-z_]+\}:([A-Za-z0-9]+)$/.exec(p))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[1]}:${m[2]}`),
);

/** Every `invoke("<literal>", "<verb>"` in the web app, with the file it is in. */
function bareCollectionCalls(): { where: string; call: string; key: string }[] {
  const found: { where: string; call: string; key: string }[] = [];
  for (const [file, src] of Object.entries(webFiles)) {
    for (const m of src.matchAll(/\binvoke\s*(?:<[^(]*>)?\(\s*"([a-z0-9-]+)"\s*,\s*"([A-Za-z0-9]+)"/g)) {
      found.push({ where: file.replace("../", ""), call: `invoke("${m[1]}", "${m[2]}")`, key: `${m[1]}:${m[2]}` });
    }
  }
  return found;
}

/**
 * Every `invoke(\`<collection>/${…}\`, "<verb>"` - the ITEM shape, which is the correct one for an item verb.
 *
 * Scanned for the OTHER half of the same mistake. The shape above is wrong about the path; this one can be
 * wrong about the verb - a rename that updated the server and the spec and missed one browser call, or a
 * typo. Both fail identically at runtime and both are swallowed by the panel that made the call, so the
 * check has to cover both spellings rather than the one that happened to bite first.
 */
function itemCalls(): { where: string; call: string; key: string }[] {
  const found: { where: string; call: string; key: string }[] = [];
  for (const [file, src] of Object.entries(webFiles)) {
    for (const m of src.matchAll(/\binvoke\s*(?:<[^(]*>)?\(\s*`([a-z0-9-]+)\/\$\{[^`]*\}`\s*,\s*"([A-Za-z0-9]+)"/g)) {
      found.push({ where: file.replace("../", ""), call: `invoke(\`${m[1]}/…\`, "${m[2]}")`, key: `${m[1]}:${m[2]}` });
    }
  }
  return found;
}

describe("the web app's custom-method calls name the right path", () => {
  it("finds the calls at all", () => {
    // The scan is worth nothing if a refactor makes it silently match nothing and pass for ever.
    expect(bareCollectionCalls().length).toBeGreaterThan(0);
  });

  it("uses a bare collection only where the method has no object", () => {
    const wrong = bareCollectionCalls().filter((c) => itemLevel.has(c.key) && !collectionLevel.has(c.key));
    // Each of these 404s at runtime and is swallowed by the panel that made it.
    expect(wrong.map((c) => `${c.where}: ${c.call} - ${c.key} is an item verb, call it as invoke(\`${c.key.split(":")[0]}/\${id}\`, "${c.key.split(":")[1]}")`)).toEqual([]);
  });

  it("names a method the spec actually has", () => {
    // A verb that is in neither set is a call to a route that does not exist at all - a rename that updated
    // the server and missed the browser.
    const unknown = bareCollectionCalls().filter((c) => !itemLevel.has(c.key) && !collectionLevel.has(c.key));
    expect(unknown.map((c) => `${c.where}: ${c.call}`)).toEqual([]);
  });

  it("finds the item-shaped calls too", () => {
    expect(itemCalls().length).toBeGreaterThan(0);
  });

  it("calls only methods the spec has from an item path", () => {
    // The mirror of the two above. `openapiRoutesDrift` holds the SERVER's routes against the spec, which
    // says nothing about what the browser asks for - so a verb the spec has never heard of, called from an
    // item path, is caught here or nowhere.
    const unknown = itemCalls().filter((c) => !itemLevel.has(c.key));
    expect(unknown.map((c) => `${c.where}: ${c.call} - no /v1/${c.key.split(":")[0]}/{id}:${c.key.split(":")[1]} in openapi.yaml`)).toEqual([]);
  });
});
