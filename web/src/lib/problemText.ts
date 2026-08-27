// What a failed request should SAY.
//
// The server speaks RFC 9457 problem details, and its `detail` is written for whoever is reading a log:
// "etag mismatch", "required: PAN, UAN", "the effective date must be after the current role's start". Shown
// to a person as-is, those range from cryptic to accusatory. This turns one into a sentence they can act on,
// keyed off the problem TYPE (stable, part of the API) rather than the prose.
//
// It runs at the API boundary - ApiError's own `message` - so every toast, every pinned form error and every
// stray `(e as Error).message` in the app reads the same way, without each call site remembering to translate.
// The untouched original stays on `error.problem.detail` for anything that needs the literal server text.
//
// Two rules hold everywhere here:
//   - never invent detail the server didn't give (a wrong-but-friendly message is worse than a blunt one), and
//   - end with what to do next, because an error the reader can't act on is just a dead end.

export type ProblemShape = { type?: string; title?: string; status?: number; detail?: string } | null;

const CONFLICT_HINT = "Someone else changed this while you had it open. Reload the page, then reapply your change.";

// `required: PAN, UAN` and friends: the API's field list is genuinely useful, the code prefix is not.
function stripCode(detail: string): string {
  const m = /^([a-z][a-z_]*):\s*(.+)$/s.exec(detail);
  return m ? m[2]! : detail;
}

export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const cased = t[0]!.toUpperCase() + t.slice(1);
  return /[.!?]$/.test(cased) ? cased : `${cased}.`;
}

export function problemText(status: number, problem: ProblemShape, statusText = ""): string {
  const type = problem?.type ?? "";
  const detail = (problem?.detail ?? "").trim();
  const said = detail ? sentence(stripCode(detail)) : "";

  // A stale etag is the one failure where the right move is never "try again" - the record moved underneath.
  if (type.endsWith("/aborted") || /etag mismatch/i.test(detail)) return CONFLICT_HINT;

  if (type.endsWith("/already-exists")) {
    return said
      ? `${said} Change it to something unique, or edit the existing record instead.`
      : "That already exists. Change it to something unique, or edit the existing record instead.";
  }
  // The attendance clock's network fence. The web clock offers the remote-work request inline (lib/clock.tsx),
  // so this is what every OTHER surface says - and it names the second way out, a correction, because whoever
  // reads it here may not be able to request remote work at all. Must precede the generic 403 branch.
  if (type.endsWith("/clock-network-fence")) {
    const next = "If you're working remotely, request remote work for these dates; otherwise file an attendance correction.";
    return said ? `${said} ${next}` : `Clocking in and out is limited to approved networks. ${next}`;
  }
  if (type.endsWith("/permission-denied") || status === 403) {
    return said || "You don't have permission to do this. Ask an admin to grant it, or to make the change for you.";
  }
  if (type.endsWith("/not-found") || status === 404) {
    return said ? `${said} It may have been deleted.` : "That record no longer exists - it may have been deleted.";
  }
  // A 400's detail IS the specific reason ("last working day is before the notice date"), so it stands alone;
  // a generic suffix would only bury it.
  if (type.endsWith("/invalid-argument") || status === 400) return said || "Some of that isn't valid. Check the fields and try again.";
  if (type.endsWith("/failed-precondition")) return said || "This can't be done in the record's current state.";
  if (type.endsWith("/unauthenticated") || status === 401) return "Your session has expired. Sign in again to continue.";
  if (status === 429) return "Too many requests just now. Wait a few seconds and try again.";
  if (status >= 500) return "The server had a problem with that. Nothing was changed - try again in a moment.";
  return said || sentence(problem?.title ?? statusText) || "Something went wrong. Try again.";
}

/** A fetch that never reached the server: the one thing worth saying is that it wasn't the form's fault. */
export function isNetworkMessage(msg: string): boolean {
  return /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
}

export const NETWORK_TEXT = "Couldn't reach the server. Check your connection and try again - nothing was saved.";
