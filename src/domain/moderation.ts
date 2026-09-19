// What may be moderated, what a model is allowed to say about it, and how to read the answer.
//
// THE MODEL FLAGS; IT NEVER HIDES. Llama Guard returns a verdict on text, and that verdict becomes a row in
// `ai_suggestions` with `feature: "moderation"` - the same advisory record triage and extraction use, with
// the same one-live-suggestion-per-record index. Hiding a post is a separate act, performed by a person.
// There is no path from a model's output to content disappearing, which is the property that makes it safe to
// run this unattended on a five-minute tick.
//
// That separate act writes the host row DIRECTLY (`services/moderation.ts` hideHost) rather than through a
// service of its own, because neither collection has one to route through: `announcements.disabled` is read
// only by the visibility filter and a suggestion is hidden by its ordinary soft delete. What it does not skip
// is the trail - the decision is audited against the POST, not against the moderation queue, so the record's
// own activity says why it went. See the note over `decideModeration`.
//
// FLAG RATHER THAN BLOCK, and the reason is asymmetric cost. A false positive that silently eats somebody's
// kudos post is a worse failure than a true positive that sits in a queue for ten minutes: the first breaks
// trust in the product and is invisible to the person it happened to, the second is a delay. So a flagged
// post stays exactly as visible as it was, and the only thing that changes is that it appears on a queue.

/**
 * The collections whose rows post publicly.
 *
 * DEFAULT DENY, like `INDEXABLE`. A collection absent here is never scanned, whatever its content. The two
 * that are here are the two public walls: `announcements` (which is also where kudos live, as `kind="kudos"`)
 * and `suggestions`. Everything else in the app is addressed to somebody - a ticket to a servicing desk, a
 * review to a manager - and a moderation queue over private correspondence is a different product with a
 * different consent story.
 *
 * WHICH COLUMNS CARRY THE TEXT IS NOT HERE. `services/moderation.ts` dueForScan binds `title` and `body` on
 * each table as typed drizzle columns, because the two walls are two tables and a name in this map could not
 * be handed to either query without giving up that typing. This map decides WHETHER a collection is scanned;
 * the query decides what it reads. An earlier version carried the column names here as well and nothing ever
 * read them, which made this look like the source of truth for something it did not control.
 */
export const MODERATABLE: Record<string, { singular: string }> = {
  // `singular` is what the audit action is named with (`announcement.moderate.hide`), matching the
  // `auditName` each collection's own route already uses - so a moderation entry reads like every other entry
  // about that record rather than like a different system's.
  announcements: { singular: "announcement" },
  suggestions: { singular: "suggestion" },
  // A REPLY IS FLAGGED ON ITS OWN, not as part of the post it sits under, and that is the whole reason it is
  // a host rather than more text folded into the announcement's scan. It is the one public surface written
  // by somebody other than the post's author: hiding the thread because a commenter was abusive would take
  // the author's post down for what somebody else wrote. The unique index is per (host, record, feature), so
  // giving replies their own host is also what lets two bad replies under one post both be flagged.
  //
  // Not a wire collection - replies are reached through the announcement's routes - but the queue addresses
  // one directly, so it is registered in `ENCODABLE` to keep its id off the wire in the clear.
  "announcement-replies": { singular: "reply" },
};

export const isModeratable = (collection: string): boolean =>
  Object.prototype.hasOwnProperty.call(MODERATABLE, collection);

/**
 * Llama Guard's hazard taxonomy, and what each one is called on screen.
 *
 * The model answers with these codes and nothing else, which is what makes the parse below strict rather
 * than hopeful. The labels are ours: "S10" tells a moderator nothing, and a queue whose reason column reads
 * as an error code is a queue people learn to clear without reading.
 */
export const HAZARDS: Record<string, string> = {
  S1: "Violent crime",
  S2: "Non-violent crime",
  S3: "Sex-related crime",
  S4: "Child sexual exploitation",
  S5: "Defamation",
  S6: "Specialised advice",
  S7: "Privacy",
  S8: "Intellectual property",
  S9: "Indiscriminate weapons",
  S10: "Hate",
  S11: "Suicide and self-harm",
  S12: "Sexual content",
  S13: "Elections",
};

/** A hazard code's label, or the bare code when the model names one outside the taxonomy it was given. An
 *  unknown code is still shown rather than dropped: it is evidence about the model, and hiding it would make
 *  a misbehaving model look like a quiet one. */
export const hazardLabel = (code: string): string => HAZARDS[code] ?? code;

export type Verdict =
  /** The model read it and had nothing to say. No row is written. */
  | { safe: true }
  /** The model objected, under these hazard codes. At least one, or it would not be unsafe. */
  | { safe: false; hazards: string[] };

/**
 * Read Llama Guard's answer.
 *
 * The documented shape is the word `safe`, or the word `unsafe` on its own line followed by a line of
 * comma-separated hazard codes. This accepts that and nothing adjacent to it: a model that starts explaining
 * itself, apologising, or answering the post instead of judging it produces `null`, and the caller records
 * nothing rather than flagging on a sentence it did not understand.
 *
 * `unsafe` with no parseable code is also `null`, deliberately. A flag whose reason column is empty is a
 * queue item a moderator cannot act on, and "the model said so" is not a reason a person can weigh.
 */
export function parseVerdict(raw: string): Verdict | null {
  const lines = raw.trim().toLowerCase().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const [head, ...rest] = lines;
  if (head === "safe") return { safe: true };
  if (head !== "unsafe") return null;

  const hazards = (rest[0] ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^S\d{1,2}$/.test(s));
  if (hazards.length === 0) return null;
  // De-duplicated and ordered, so two scans of the same text produce the same row and the unique index does
  // not churn on ordering alone.
  return { safe: false, hazards: [...new Set(hazards)].sort() };
}

/**
 * What the model is shown: the post's text, trimmed and capped. An unbounded body is an unbounded prompt,
 * and a generation call runs unattended on a five-minute tick.
 *
 * KNOWN AND ACCEPTED: THIS IS A CEILING ON WHAT IS READ, NOT A SUMMARY OF IT. Anything past this point is
 * never seen, so a long post can carry abuse below the cut and pass clean. The cap is a cost decision and
 * it buys a real hole in a safety feature, which is worth saying plainly rather than leaving for somebody
 * to discover from a queue that stayed empty.
 *
 * It is tolerable today because the two walls are short-form by construction - a noticeboard post, a
 * suggestion, a reply - so a body long enough to exploit it is already unusual enough to notice. If that
 * stops being true, the fix is to scan the tail as a second call rather than to raise this: doubling the
 * cap doubles the cost of every ordinary post to catch the one that is padded.
 */
export const MAX_SCAN_CHARS = 2_000;

/**
 * Variadic because a post is not always two fields. A poll carries its choices in
 * `announcement_poll_options.label`, written by the same author at the same moment as the body, and those
 * labels were invisible to the scan while this took exactly a title and a body - so a poll whose question
 * was innocuous and whose options were not passed clean.
 */
export function scanText(...parts: (string | null | undefined)[]): string {
  return parts.map((s) => (s ?? "").trim()).filter(Boolean).join("\n\n").slice(0, MAX_SCAN_CHARS);
}

/** The excerpt stored on the flag: what the model actually read, so a moderator is judging the same text and
 *  an edit after the fact is visible as a difference rather than silently replacing the evidence. */
export const MAX_EXCERPT_CHARS = 400;
export const excerptOf = (text: string): string =>
  text.length <= MAX_EXCERPT_CHARS ? text : `${text.slice(0, MAX_EXCERPT_CHARS).trimEnd()}...`;

/** What a moderator decided. `hide` withdraws the post through its own collection's write; `dismiss` leaves
 *  it exactly where it is and closes the flag. There is no third option, and in particular no "delete": a
 *  hidden post is recoverable by the same people who hid it, and an unrecoverable one is a different
 *  authority than moderation. */
export type ModerationAction = "hide" | "dismiss";
export const MODERATION_ACTIONS: readonly ModerationAction[] = ["hide", "dismiss"];
export const isModerationAction = (v: unknown): v is ModerationAction =>
  typeof v === "string" && (MODERATION_ACTIONS as readonly string[]).includes(v);

/** The payload stored on the flag row. Small and self-describing, because it is read back by a queue that
 *  must not have to re-run the scan to render a row. */
export type ModerationPayload = {
  hazards: string[];
  excerpt: string;
  /** Whether the host row hides its author from readers, carried onto the flag so the queue cannot leak an
   *  identity the wall itself withholds. See `services/moderation.ts` for why this is decided at scan time. */
  anonymous: boolean;
};
