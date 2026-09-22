// What may be moderated, what a model is allowed to say about it, and how to read the answer.
//
// TWO PASSES, ONE QUEUE. This file owns the hazard pass (Llama Guard, statutory-grade harm); `domain/conduct.ts`
// owns the workplace-conduct pass that catches what a safety taxonomy has no category for. Both write the
// same flag with the same `hazards` array, so a moderator reads one queue.
//
// THE MODEL FLAGS; IT DOES NOT HIDE. Llama Guard returns a verdict on text, and that verdict becomes a row in
// `ai_suggestions` with `feature: "moderation"` - the same advisory record triage and extraction use, with
// the same one-live-suggestion-per-record index. Hiding a post is a separate act, performed by a person, and
// that is the property which makes it safe to run this unattended on a five-minute tick.
//
// PRECISELY: nothing hides a post unless a super admin wires a rule that does, and `pass` exists so they can.
// `recordFlag` emits `moderation.flagged`, the automation engine's `apiCall` action can POST any endpoint,
// and `/v1/moderation:decide` with `action: "hide"` is an endpoint - `domain/events.ts` is explicit that the
// `pass` field is carried because it is what a rule that HIDES must condition on. The guard is real:
// `apiCall` is in `PRIVILEGED_ACTION_KINDS` beside `webhook` and `email`, `assertMayAuthorActions` refuses a
// non-super author, `collectActionKinds` recurses into `wait`/`waitFor` arms so it cannot hide inside a
// continuation, and `assertMayActOnStored` applies the same gate to enable/disable/delete. So the claim is
// bounded by a configuration default rather than absolute, and stating it absolutely would not survive
// somebody finding the `apiCall` action. Out of the box, and for every author below super admin, no model
// output can make content disappear.
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
import { CONDUCT_HAZARDS } from "./conduct";

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
export const MODERATABLE: Record<string, { singular: string; anonymity: boolean }> = {
  // `singular` is what the audit action is named with (`announcement.moderate.hide`), matching the
  // `auditName` each collection's own route already uses - so a moderation entry reads like every other entry
  // about that record rather than like a different system's.
  //
  // `anonymity` is whether a post on this wall can be UNATTRIBUTED, and it is here rather than in a list of
  // its own so the two cannot drift: the org's scanning scope offers "anonymous posts only" exactly on the
  // walls where that describes something, and the settings validator refuses it on the walls where it would
  // silently mean "nothing". A wall that later grows an anonymity flag turns the option on by declaring it
  // here, beside the flag's own name.
  announcements: { singular: "announcement", anonymity: false },
  suggestions: { singular: "suggestion", anonymity: true },
  // A REPLY IS FLAGGED ON ITS OWN, not as part of the post it sits under, and that is the whole reason it is
  // a host rather than more text folded into the announcement's scan. It is the one public surface written
  // by somebody other than the post's author: hiding the thread because a commenter was abusive would take
  // the author's post down for what somebody else wrote. The unique index is per (host, record, feature), so
  // giving replies their own host is also what lets two bad replies under one post both be flagged.
  //
  // Not a wire collection - replies are reached through the announcement's routes - but the queue addresses
  // one directly, so it is registered in `ENCODABLE` to keep its id off the wire in the clear.
  "announcement-replies": { singular: "reply", anonymity: false },
};

export const isModeratable = (collection: string): boolean =>
  Object.prototype.hasOwnProperty.call(MODERATABLE, collection);

/**
 * WHICH POSTS THIS ORGANISATION WANTS READ, which is a different question from which posts CAN be read.
 *
 * `MODERATABLE` above is structural: it is the set of walls the feature knows how to scan, and it does not
 * change with configuration. This is the org's policy over that set, per wall:
 *
 *   `all`        every post on this wall (the default, and what the feature did before this existed)
 *   `anonymous`  only posts nobody's name is attached to
 *   `off`        this wall is not scanned at all
 *
 * WHY `anonymous` IS WORTH ITS OWN POSITION rather than being left to "all or nothing". An unattributed post
 * is the one place the ordinary deterrent is missing: on a noticeboard a person's name is beside what they
 * wrote, and that alone does most of the work a moderation queue would otherwise do. The suggestion box
 * deliberately removes it, so the same wall that makes people willing to raise something uncomfortable is
 * also the one where abuse costs nothing. An org can reasonably decide that is the only place worth spending
 * a model on - and it is the cheapest possible configuration of this feature, since anonymous posts are a
 * small share of the traffic.
 *
 * SCANNING IS NOT THE ONLY THING MODERATION DOES. A wall set to `off` still has a moderation queue, and a
 * moderator can still hide a post on it by hand (`hideManually`) and put it back. What `off` stops is the
 * MODEL reading it, and therefore the gate holding it - which is the thing being consented to here.
 */
export const MODERATION_WALL_SCOPES = ["all", "anonymous", "off"] as const;
export type ModerationWallScope = (typeof MODERATION_WALL_SCOPES)[number];
export type ModerationScope = Record<string, ModerationWallScope>;

/** The walls where `anonymous` describes something, derived from the registry rather than kept beside it. */
export const ANONYMITY_WALLS: readonly string[] =
  Object.entries(MODERATABLE).filter(([, m]) => m.anonymity).map(([collection]) => collection);

/**
 * Is this post one the org has asked to have read?
 *
 * `post` is the row itself where the caller has it. Where it does not - a write path deciding whether to
 * hold a row it has not built yet - an absent or unknown `anonymous` reads as IN SCOPE, which is the
 * conservative direction: the row is held for the length of one call and the gate, which does have the row,
 * releases it immediately if it turns out not to be covered. The opposite default would let an in-scope post
 * reach a wall unread while the caller worked out what it was.
 */
export function moderationCovers(
  scope: ModerationScope | undefined,
  collection: string,
  post?: { anonymous?: boolean | null },
): boolean {
  if (!isModeratable(collection)) return false;
  const chosen = scope?.[collection] ?? "all";
  if (chosen === "off") return false;
  if (chosen === "all") return true;
  return post?.anonymous !== false;
}

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
 *  a misbehaving model look like a quiet one.
 *
 *  Conduct codes (`W*`, domain/conduct.ts) resolve here too, because the queue holds one `hazards` array per
 *  flag and a moderator reading it should not have to know which of the two passes objected. */
export const hazardLabel = (code: string): string => HAZARDS[code] ?? CONDUCT_HAZARDS[code] ?? OUTCOME_LABELS[code] ?? code;

/**
 * The reason on a flag that no model produced.
 *
 * With the gate on, a post is held when the check could not be completed - the model was down, out of
 * budget, or answered with something that was not a verdict - as well as when it objected. That hold needs
 * a reason a moderator can act on, and "no hazards" would render as a blank column on a post they are being
 * asked to release. It is deliberately not one of Llama Guard's codes: nothing was found, because nothing
 * was read.
 */
export const UNCHECKED = "UNCHECKED";

/**
 * The reason on a post a PERSON took down, with no model involved.
 *
 * A manual hide still writes a flag row, and it has to: the queue's decided view is the only place a
 * withdrawn post can be seen, so a takedown that recorded nothing would put the post beyond reach of every
 * surface in the app - the same hole an upheld hold used to fall into. The "hazard" is therefore not one:
 * it says a person decided, which is the honest reason and the one a reader of the history needs.
 */
export const MANUAL = "MANUAL";

const OUTCOME_LABELS: Record<string, string> = { [UNCHECKED]: "Not checked", [MANUAL]: "Hidden by a person" };

/** Hazard labels, lower-cased, back to their codes. Built once: the object dialect below sometimes names a
 *  category rather than coding it. */
const CODE_BY_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(HAZARDS).map(([code, label]) => [label.toLowerCase(), code]),
);

/**
 * One category the model named, as a taxonomy code, or null when it is not one.
 *
 * Three spellings are accepted because all three have been observed from the same model family: the bare
 * code (`S10`), the code with its name after it (`S10: Hate`), and the name alone (`Hate`). Anything else is
 * null - a category this app cannot name is a reason a moderator cannot weigh.
 */
export function hazardCode(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const coded = /^(S\d{1,2})\b/i.exec(s);
  if (coded) return coded[1]!.toUpperCase();
  return CODE_BY_LABEL[s.toLowerCase()] ?? null;
}

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
  const text = raw.trim();
  if (text.startsWith("{")) return parseObjectVerdict(text);

  const lines = text.toLowerCase().split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const [head, ...rest] = lines;
  if (head === "safe") return { safe: true };
  if (head !== "unsafe") return null;

  return unsafeWith((rest[0] ?? "").split(","));
}

/**
 * The OBJECT dialect: `{"safe":true}` or `{"safe":false,"categories":["S10"]}`.
 *
 * Workers AI post-processes the guard model's two-line answer into this shape before the binding returns it
 * (`Ai_Cf_Meta_Llama_Guard_3_8B_Output`), so in production this is the branch that runs and the text branch
 * above is what a raw model or a test hands over. Reading only the text form is what made a working scan
 * look like a broken one: every verdict arrived as an object, nothing could parse it, and no post was ever
 * flagged. `lib/ai.ts` serialises it back to JSON rather than picking a dialect for us.
 */
function parseObjectVerdict(text: string): Verdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as { safe?: unknown; categories?: unknown };
  if (typeof o.safe !== "boolean") return null;
  if (o.safe) return { safe: true };
  return unsafeWith(Array.isArray(o.categories) ? o.categories.map((c) => String(c)) : []);
}

/** The unsafe half of both dialects: codes in, one verdict out, or null when none of them is a code we can
 *  name. De-duplicated and ordered, so two scans of the same text produce the same row and the unique index
 *  does not churn on ordering alone. */
function unsafeWith(categories: string[]): Verdict | null {
  const hazards = categories.map(hazardCode).filter((c): c is string => c !== null);
  if (hazards.length === 0) return null;
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

/**
 * WHERE A POST LANDS WHEN IT IS PUT BACK, which is a second question with the same answer to the first one.
 *
 * `draft` returns it to its author's hands: off the wall, editable, nobody notified, and the way back out is
 * the ordinary publish, which sends the text through the check afresh. It is the cautious default and the
 * only thing `:unhide` used to do.
 *
 * `publish` puts it straight back in front of readers. A moderator who has looked at the post and disagrees
 * with the takedown should not have to ask its author to press Publish before anybody can see it again -
 * which, for a colleague on leave or an author who has left, meant the post never came back at all. The two
 * are the same power (reversing a takedown) and so the same verb; which one ran is recorded on the flag.
 */
export type UnhideMode = "draft" | "publish";
export const UNHIDE_MODES: readonly UnhideMode[] = ["draft", "publish"];
export const isUnhideMode = (v: unknown): v is UnhideMode =>
  typeof v === "string" && (UNHIDE_MODES as readonly string[]).includes(v);

/** The payload stored on the flag row. Small and self-describing, because it is read back by a queue that
 *  must not have to re-run the scan to render a row. */
export type ModerationPayload = {
  hazards: string[];
  excerpt: string;
  /** Whether the host row hides its author from readers, carried onto the flag so the queue cannot leak an
   *  identity the wall itself withholds. See `services/moderation.ts` for why this is decided at scan time. */
  anonymous: boolean;
  /**
   * THE POST NEVER WENT PUBLIC: the gate withheld it at the moment it was written.
   *
   * This is the difference between the two things a flag can mean, and everything downstream turns on it:
   *
   *  - WITHOUT it, the post is on the wall and the flag is advisory. A moderator's `hide` takes it down and
   *    `dismiss` leaves it where it is. That is the original design and still what happens when the gate is
   *    off (a flag raised by the cron sweep over posts that predate it).
   *  - WITH it, the post is already invisible and was never announced. `hide` confirms that; `dismiss`
   *    RELEASES it - publishes it and sends the broadcast that was held back with it.
   *
   * It is also what keeps the flag ON the queue. `liveHosts` drops a flag whose host nobody can see, which
   * is right for a post its author withdrew and catastrophic for one the gate is holding: the post would be
   * invisible on the wall AND absent from the queue, with nothing left that could release it.
   *
   * Carried in the payload rather than as a new `ai_suggestions.state`: the states are shared with every
   * other advisory feature and mean "has a human answered this yet", which is a different question, and a
   * held flag is still `pending` in exactly that sense.
   */
  held?: boolean;
};
