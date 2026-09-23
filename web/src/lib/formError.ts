import { ApiError } from "@/api";
import { isNetworkMessage, NETWORK_TEXT, sentence } from "@/lib/problemText";

// One human sentence for anything a write handler can throw.
//
// ApiError already carries a humanised `message` (built at the API boundary from the problem details), so the
// work left here is the non-API cases: a network failure that never reached the server, and a plain bug in a
// handler. Every write dialog runs its catch through this, which is why no dialog needs its own error prose.
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (isNetworkMessage(msg)) return NETWORK_TEXT;
  return msg ? sentence(msg) : "Something went wrong. Try again.";
}

/** True when the failure was a lost race rather than bad input: the caller may want to offer a reload. */
export function isConflict(e: unknown): boolean {
  return e instanceof ApiError && (e.problem?.type?.endsWith("/aborted") === true || /etag mismatch/i.test(e.problem?.detail ?? ""));
}

/**
 * Which FIELDS a failure was about, keyed by wire field name.
 *
 * A 400 shown as one sentence above a twelve-field form makes the reader hunt for the field it means. The
 * server names them two ways: a `fields` array on a body validation failure (path + reason), and the older
 * `code: a, b` detail prefix that several services still use ("required: pan, uan"). Both end up here, so
 * `WriteDialog` can hand each message to the field that owns it - see `Field`'s `field` prop.
 *
 * Anything that can't be attributed to a field is left alone: it stays the pinned form-level message, which is
 * the honest place for "leave overlaps an existing request".
 */
export function fieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  const out: Record<string, string> = {};
  for (const f of e.problem?.fields ?? []) {
    // The dialog's fields are top-level wire keys; a nested path ("sessions.0.start_time") is attributed to the
    // field that contains it, which is the one on screen.
    const key = f.field.split(".")[0];
    if (key && !out[key]) out[key] = sentence(f.message);
  }
  const detail = (e.problem?.detail ?? "").trim();
  const listed = /^(required|invalid|unknown|missing|duplicate)s?:\s*(.+)$/i.exec(detail);
  if (listed) {
    const reason = listed[1]!.toLowerCase();
    for (const raw of listed[2]!.split(",")) {
      // Only bare field tokens: a detail whose tail is a sentence ("required: at least one line") names no field.
      const name = raw.trim();
      if (!name || !/^[a-z][a-z0-9_]*$/i.test(name)) continue;
      const key = name.toLowerCase();
      if (!out[key]) out[key] = reason === "required" || reason === "missing" ? "This is required." : `This is ${reason}.`;
    }
  }
  return out;
}
