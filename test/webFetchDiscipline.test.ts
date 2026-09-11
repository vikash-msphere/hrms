/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";

// Every call the SPA makes to the Worker goes through web/src/api.ts. That module is not a convenience wrapper -
// it is where five separate contracts are kept, and each one is invisible when it is missing:
//
//   1. `X-View-As`. While an access admin holds a simulation open, EVERY request must carry the subject header,
//      because src/lib/viewAs.ts only engages the simulation's rails when it sees one. A request without it is
//      answered as the real admin - so the screen that exists to show what somebody else sees quietly shows
//      what the admin sees, which is the one answer it must never give.
//   2. `guardReadOnly`. A simulation is read-only (viewAs.ts isReadOnly), so a POST-shaped read is refused
//      client-side with a sentence that says what to do, rather than as a bare server 403.
//   3. `handle401`. A lapsed session raises the in-place "sign in again" overlay and tells sibling tabs. A raw
//      fetch just gets a 401 nobody reads, and the screen sits on a spinner for ever.
//   4. Transient retry. A read is re-asked twice on a gateway blip; a binary method is the request most worth
//      retrying, because a whole PDF render sits behind it.
//   5. `ApiError` + problemText. The person sees the server's own sentence instead of "HTTP 500".
//
// None of those failures is visible in review, in tsc, or in a green test run: the raw fetch WORKS, it just
// works as the wrong caller and fails in the wrong way. Four of them had drifted in (two document downloads, the
// signature image and the letter preview) before this test existed, so the rule is pinned by name.
//
// Use `api`/`get`/`patch`/`invoke` for JSON, and `blobOf`/`dataUrl`/`blobUrl`/`download` for a binary custom
// method. A genuinely un-clientable call is an EXCEPTION below, with the reason it cannot be one.
const web = {
  ...(import.meta.glob("../web/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>),
  ...(import.meta.glob("../web/src/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>),
};

const rel = (p: string) => p.replace("../web/src/", "");

// `fetch("/v1…")` or `fetch(`/v1…`)`, and the same for `/auth`. Deliberately anchored on the LITERAL path: a
// fetch of a static asset, a blob: URL or a third-party origin is not what this rule is about, and matching a
// bare `fetch(` would collect all of them and turn the allow-list into noise.
const WORKER_FETCH = /\bfetch\(\s*[`"](\/(?:v1|auth)\b[^`"]*)/g;

// Scanned LINE BY LINE so that prose can name the thing it is forbidding - `lib/getCoalescer.ts` and
// `instrument.ts` both describe `fetch("/v1…")` in a comment, and a whole-file regex reads those as offences.
// A line whose first non-space character opens a comment cannot also contain a real call, so skipping exactly
// those is fail-CLOSED: no reachable statement is excused, and stripping comments properly (which means
// tracking string literals, because `"https://…"` contains `//`) would be the fail-open way to do this.
const isCommentLine = (line: string) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

// file -> why this one call cannot go through the client.
const ALLOW: Record<string, string> = {
  "api.ts": "the client itself",
  // The expired-session dialog asks "am I signed in yet?" while the app is already in its 401 flow. Routed
  // through api() it would re-enter handle401 on every check - the flow re-firing itself - so the one request
  // whose whole purpose is to TEST the session is the one that must not react to its answer.
  "App.tsx": "session-expired probe: api()'s own 401 handling would re-fire the flow it is checking",
  // /auth is not /v1. The client is a /v1 client - it prefixes the path, speaks Problem+JSON and carries the
  // view-as header, none of which apply to the sign-out endpoint, which answers with a provider redirect.
  "components/layout/UserMenu.tsx": "/auth/logout is outside the /v1 surface the client speaks",
};

describe("the SPA reaches the Worker only through web/src/api.ts", () => {
  const offenders: string[] = [];
  const unusedAllow = new Set(Object.keys(ALLOW));

  for (const [path, src] of Object.entries(web)) {
    const file = rel(path);
    const hits = src
      .split("\n")
      .flatMap((line, i) => (isCommentLine(line) ? [] : [...line.matchAll(WORKER_FETCH)].map((m) => `${file}:${i + 1}: fetch("${m[1]}")`)));
    if (!hits.length) continue;
    if (file in ALLOW) {
      unusedAllow.delete(file);
      continue;
    }
    offenders.push(...hits);
  }

  it("makes no hand-rolled fetch to /v1 or /auth", () => {
    expect(offenders).toEqual([]);
  });

  // An allow entry is a claim about a call that exists. Left behind after the call is gone, it silently
  // re-permits the next one added to that file - which is exactly how the four this test was written for got in.
  it("carries no stale exception", () => {
    expect([...unusedAllow]).toEqual([]);
  });
});
