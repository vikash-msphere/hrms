// The guided workflow editor's body round-trip: a JSON value rendered as one line of text, and that text read
// back as the same JSON value.
//
// ITS OWN MODULE so it can be tested. `ActionList.tsx` is a React component tree that reaches `window` through
// its imports, and neither test runner in this repo has a DOM - so a pure function sitting inside it was
// unreachable from a test while being exactly the kind of thing that wants one: total, table-driven, and
// silently lossy when it is wrong. See test/workflowBodyRoundTrip.test.ts.

export type BodyRow = { key: string; value: string };

/** One row per field, the value as the text the editor shows. */
export function bodyToRows(body: unknown): BodyRow[] {
  return body && typeof body === "object" && !Array.isArray(body)
    ? Object.entries(body as Record<string, unknown>).map(([k, v]) => ({ key: k, value: typeof v === "string" ? v : JSON.stringify(v) }))
    : [];
}

/** A body this field form cannot represent: an array, or a scalar. Shown read-only rather than erased. */
export function isFieldMap(body: unknown): boolean {
  return body == null || (typeof body === "object" && !Array.isArray(body));
}

// THE ROUND-TRIP HAS TO BE LOSSLESS. Numbers and booleans survived it; an array, a nested object and `null`
// did not - `rowsToBody` had no branch that parsed one back, so `["employees/a1"]` was shown in the row and
// written back as the STRING '["employees/a1"]'. And editing any row re-serialises all of them, so touching
// an unrelated field was enough. Several write schemas require arrays (goal-templates `:assign` takes
// `employees`, cards `initial_todos`, announcements poll `options`), the guided form cannot author one at
// all, so such a rule has to be written through the JSON hatch - and then merely OPENING it here and
// touching the body converted it to a string, which the server rejects with a 400 naming a field the reader
// never typed wrong.
//
// The last line used to break the same invariant in the other direction: `!Number.isNaN(Number(v))` coerced
// any numeric-LOOKING string to a number, so the string "0042" round-tripped to 42 (leading zeros lost, which
// matters for any code or identifier stored as text), "Infinity" became a number that `JSON.stringify` then
// writes as `null`, and " " passed the `v !== ""` guard while `Number(" ")` is 0. Requiring the text to
// round-trip EXACTLY keeps "42" and "4.5" as numbers and leaves every one of those as the string it was.
export function parseValue(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v.includes("{{")) return v; // a template is always a string
  if (/^[[{]/.test(v.trim())) { try { return JSON.parse(v); } catch { return v; } }
  const t = v.trim();
  const n = Number(t);
  // `Number.isFinite` as well as the exact round-trip, because "Infinity" satisfies `String(Number(t)) === t`
  // and is the one case where the coerced value cannot survive `JSON.stringify` - it goes out as `null`.
  return t !== "" && Number.isFinite(n) && String(n) === t ? n : v;
}

/** The rows back into a body object; an empty form writes no body at all rather than `{}`. */
export function rowsToBody(rows: BodyRow[]): Record<string, unknown> | undefined {
  const entries = rows.filter((r) => r.key.trim());
  if (!entries.length) return undefined;
  const out: Record<string, unknown> = {};
  for (const r of entries) out[r.key] = parseValue(r.value);
  return out;
}
