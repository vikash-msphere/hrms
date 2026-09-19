// Moderation: scanning the public walls, the queue that results, and what a person may do from it.
//
// THE SHAPE, IN ONE LINE. A bounded cron pass asks a guard model about posts it has not seen before, writes
// an advisory row when the model objects, and stops. Everything after that is a human reading a queue.
//
// WHY THE SCAN IS A RECONCILIATION. `moderation_scans` records what was scanned and the hash of the text it
// was scanned from, so an edit brings a post back round and an unchanged one is never paid for twice. It is
// the same design as the embed drain next door and for the same reason: nothing in the database announces a
// write to a service, so the only reliable question is "what does the record say now, and does that match
// what we last looked at".
//
// WHAT THIS FILE DELIBERATELY CANNOT DO. It cannot hide anything on its own. `drainModeration` writes flags;
// `decideModeration` is the only thing that touches a post, it takes a human's verdict as an argument, and it
// is reached through a capability somebody had to be granted. A model that decides every kudos post is hate
// speech produces a long queue and no missing content.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { invalidArgument, notFound } from "../lib/errors";
import { BUDGET, MODELS, UNTRUSTED_PREAMBLE } from "../domain/aiPolicy";
import {
  MODERATABLE,
  excerptOf,
  hazardLabel,
  isModeratable,
  parseVerdict,
  scanText,
  type ModerationAction,
  type ModerationPayload,
} from "../domain/moderation";
import { aiFeatureOn, aiGenerate } from "./ai";
import { notify } from "./notifications";

const PROMPT_VERSION = "v1";
const FEATURE = "moderation";

export type ModerationDrainResult = { scanned: number; flagged: number; skipped?: string };

/**
 * One scan pass. Never throws: it runs inside the cron dispatch, where one subtask failing must not take the
 * tick down, and a wall that is five minutes behind is not an incident.
 */
export async function drainModeration(deps: Deps): Promise<ModerationDrainResult> {
  if (!deps.ai) return { scanned: 0, flagged: 0, skipped: "no ai binding" };
  // The org's switch gates the SCANNING, not just the queue. Sending every post through a model for a feature
  // nobody enabled would be the opt-in in name only - the text would already have been read by the time
  // anyone decided it could be.
  if (!(await aiFeatureOn(deps, "moderation"))) return { scanned: 0, flagged: 0, skipped: "moderation is off" };

  const candidates = await dueForScan(deps, BUDGET.moderationsPerDrain);
  if (candidates.length === 0) return { scanned: 0, flagged: 0 };

  let scanned = 0;
  let flagged = 0;
  for (const c of candidates) {
    const hash = await sha256Hex(c.text);
    // Unchanged since the last look: stamp it so the rotation moves past it, and spend nothing. This is the
    // common case by a wide margin, which is the whole reason the bookkeeping table exists.
    if (c.knownHash === hash && c.knownModel === MODELS.moderate) {
      await stampScan(deps, c.collection, c.recordId, hash, c.flagged);
      continue;
    }

    const out = await aiGenerate(
      deps,
      { feature: FEATURE, collection: c.collection },
      { system: SYSTEM, user: `${UNTRUSTED_PREAMBLE}\n\n<post>\n${c.text}\n</post>`, promptVersion: PROMPT_VERSION, maxTokens: 32 },
    );
    // Out of budget, no binding, or the model failed. All three are states to sit out: no scan row is written,
    // so the post comes back round next tick rather than being recorded as cleared by a call that never landed.
    if (!out.ok) break;

    const verdict = parseVerdict(out.value);
    if (verdict === null) {
      // The model said something that is not a verdict. Recorded as scanned ANYWAY, and that is deliberate: a
      // model that reliably answers in the wrong shape would otherwise pin the same few posts at the front of
      // every window forever and starve the rest of the wall. The post is left unflagged, which is the safe
      // direction for a feature that only ever adds work for a human.
      console.error(`moderation: unparseable verdict for ${c.collection}/${c.recordId}`);
      await stampScan(deps, c.collection, c.recordId, hash, false);
      scanned += 1;
      continue;
    }

    if (verdict.safe) {
      await stampScan(deps, c.collection, c.recordId, hash, false);
      // A post edited from objectionable to fine retires its own flag. Left standing it would be a queue item
      // about text that no longer exists, which is the moderator's time spent on the model's behalf.
      await supersedeFlag(deps, c.collection, c.recordId);
    } else {
      await stampScan(deps, c.collection, c.recordId, hash, true);
      await recordFlag(deps, c, verdict.hazards);
      flagged += 1;
    }
    scanned += 1;
  }
  return { scanned, flagged };
}

// ---------------------------------------------------------------------------------------------------------

type Candidate = {
  collection: string;
  recordId: string;
  text: string;
  anonymous: boolean;
  knownHash: string | null;
  knownModel: string | null;
  flagged: boolean;
};

/**
 * Posts due for a look: never scanned first, then longest-unchecked.
 *
 * Only PUBLIC rows. An unpublished or disabled announcement and a soft-deleted suggestion are not on a wall,
 * so scanning them would spend a generation call on text nobody can read - and, worse, would put a flag on
 * the queue for a post that is already invisible.
 */
async function dueForScan(deps: Deps, limit: number): Promise<Candidate[]> {
  const scans = schema.moderationScans;
  const a = schema.announcements;
  const s = schema.suggestions;

  const announcements = await deps.db
    .select({
      recordId: a.uuid,
      title: a.title,
      body: a.body,
      knownHash: scans.textHash,
      knownModel: scans.model,
      flagged: scans.flagged,
      scannedAt: scans.scannedAt,
    })
    .from(a)
    .leftJoin(scans, and(eq(scans.collection, "announcements"), eq(scans.recordId, a.uuid)))
    .where(and(isNull(a.deleteTime), eq(a.published, true), eq(a.disabled, false)))
    .orderBy(sql`case when ${scans.uuid} is null then 0 else 1 end`, sql`${scans.scannedAt} asc`)
    .limit(limit);

  const suggestions = await deps.db
    .select({
      recordId: s.uuid,
      title: s.title,
      body: s.body,
      anonymous: s.anonymous,
      knownHash: scans.textHash,
      knownModel: scans.model,
      flagged: scans.flagged,
      scannedAt: scans.scannedAt,
    })
    .from(s)
    .leftJoin(scans, and(eq(scans.collection, "suggestions"), eq(scans.recordId, s.uuid)))
    .where(isNull(s.deleteTime))
    .orderBy(sql`case when ${scans.uuid} is null then 0 else 1 end`, sql`${scans.scannedAt} asc`)
    .limit(limit);

  // `scannedAt` rides along only to order the merge below, and is dropped before the candidates are returned:
  // it is bookkeeping about the sweep, not something a scan needs to know about itself.
  const rows: (Candidate & { scannedAt: Date | null })[] = [
    ...announcements.map((r) => ({
      collection: "announcements",
      recordId: r.recordId,
      text: scanText(r.title, r.body),
      anonymous: false,
      knownHash: r.knownHash,
      knownModel: r.knownModel,
      flagged: r.flagged ?? false,
      scannedAt: r.scannedAt,
    })),
    ...suggestions.map((r) => ({
      collection: "suggestions",
      recordId: r.recordId,
      text: scanText(r.title, r.body),
      anonymous: r.anonymous,
      knownHash: r.knownHash,
      knownModel: r.knownModel,
      flagged: r.flagged ?? false,
      scannedAt: r.scannedAt,
    })),
  ].filter((r) => r.text.length > 0);

  // Both walls are merged and re-ordered on the same rule, so one busy collection cannot starve the other:
  // never-scanned first, then oldest. The per-collection queries above each took `limit` so that this has
  // something to choose between, and the slice is what holds the tick to its budget.
  return rows
    .sort((x, y) => {
      const xNew = x.scannedAt === null;
      const yNew = y.scannedAt === null;
      if (xNew !== yNew) return xNew ? -1 : 1;
      return (x.scannedAt?.getTime() ?? 0) - (y.scannedAt?.getTime() ?? 0);
    })
    .slice(0, limit)
    .map(({ scannedAt: _scannedAt, ...c }) => c);
}

async function stampScan(deps: Deps, collection: string, recordId: string, hash: string, flagged: boolean): Promise<void> {
  const now = deps.clock.now();
  await deps.db
    .insert(schema.moderationScans)
    .values({ collection, recordId, textHash: hash, model: MODELS.moderate, flagged, scannedAt: now })
    .onConflictDoUpdate({
      target: [schema.moderationScans.collection, schema.moderationScans.recordId],
      set: { textHash: hash, model: MODELS.moderate, flagged, scannedAt: now, updatedAt: now },
    });
}

/** The flag itself: one advisory row, upserted, so a re-scan replaces its predecessor rather than stacking a
 *  second opinion about the same post next to the first. */
async function recordFlag(deps: Deps, c: Candidate, hazards: string[]): Promise<void> {
  const now = deps.clock.now();
  const payload: ModerationPayload = { hazards, excerpt: excerptOf(c.text), anonymous: c.anonymous };
  await deps.db
    .insert(schema.aiSuggestions)
    .values({
      hostCollection: c.collection,
      hostRecordId: c.recordId,
      feature: FEATURE,
      payloadJson: JSON.stringify(payload),
      model: MODELS.moderate,
      basis: hazards.length,
    })
    .onConflictDoUpdate({
      target: [schema.aiSuggestions.hostCollection, schema.aiSuggestions.hostRecordId, schema.aiSuggestions.feature],
      // A re-scan clears the previous decision with the previous flag. The text changed, so a moderator's
      // "this is fine" was about something else, and carrying it forward would let an edit inherit a verdict.
      set: {
        payloadJson: JSON.stringify(payload),
        basis: hazards.length,
        model: MODELS.moderate,
        state: "pending",
        decidedBy: null,
        decidedAt: null,
        updatedAt: now,
      },
    });
}

/** Retire a flag whose post no longer reads the way it did, without pretending a person decided anything. */
async function supersedeFlag(deps: Deps, collection: string, recordId: string): Promise<void> {
  await deps.db
    .update(schema.aiSuggestions)
    .set({ state: "superseded", updatedAt: deps.clock.now() })
    .where(and(
      eq(schema.aiSuggestions.hostCollection, collection),
      eq(schema.aiSuggestions.hostRecordId, recordId),
      eq(schema.aiSuggestions.feature, FEATURE),
      eq(schema.aiSuggestions.state, "pending"),
    ));
}

// ---------------------------------------------------------------------------------------------------------

export type QueueItem = {
  host: string; // "<collection>/<uuid>"
  collection: string;
  hazards: string[];
  hazard_labels: string[];
  excerpt: string;
  /** The post as it reads NOW, which is not always the text that was flagged - an author may have edited it
   *  since. Both are shown so a moderator can see that happened rather than judging a quote that no longer
   *  matches the wall. */
  title: string;
  edited_since_flag: boolean;
  author: string | null; // employee ref, or null when the wall withholds it
  flagged_time: string;
};

/**
 * The pending queue, newest first.
 *
 * WHO IS NAMED HERE, AND WHY IT IS NOT ALWAYS THE AUTHOR. The suggestion wall lets people post anonymously,
 * and that promise is to the READER as much as to the submitter - a moderation queue that resolves the name
 * would make "anonymous" mean "anonymous unless somebody complains about you", which is not what was offered.
 * So an anonymous suggestion comes through with a null author, and the only way back to a person is the same
 * one everybody else has: there is not one.
 */
export async function listModerationQueue(deps: Deps): Promise<QueueItem[]> {
  const f = schema.aiSuggestions;
  const flags = await deps.db
    .select({
      hostCollection: f.hostCollection,
      hostRecordId: f.hostRecordId,
      payloadJson: f.payloadJson,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })
    .from(f)
    .where(and(eq(f.feature, FEATURE), eq(f.state, "pending")))
    .orderBy(desc(f.updatedAt))
    .limit(100);
  if (flags.length === 0) return [];

  const live = await liveHosts(deps, flags.map((r) => ({ collection: r.hostCollection, recordId: r.hostRecordId })));

  const out: QueueItem[] = [];
  for (const flag of flags) {
    const key = `${flag.hostCollection}/${flag.hostRecordId}`;
    const host = live.get(key);
    // The post went away between the scan and the queue read - deleted by its author, or hidden by somebody
    // else. There is nothing left to moderate, so it is simply not listed.
    if (!host) continue;
    const payload = readPayload(flag.payloadJson);
    if (!payload) continue;
    out.push({
      host: key,
      collection: flag.hostCollection,
      hazards: payload.hazards,
      hazard_labels: payload.hazards.map(hazardLabel),
      excerpt: payload.excerpt,
      title: host.title,
      edited_since_flag: excerptOf(scanText(host.title, host.body)) !== payload.excerpt,
      author: payload.anonymous || !host.author ? null : `employees/${host.author}`,
      flagged_time: (flag.updatedAt ?? flag.createdAt ?? new Date(0)).toISOString(),
    });
  }
  return out;
}

type LiveHost = { title: string; body: string; author: string | null };

/** The current state of every flagged post, read from its own table. Two queries, not one per row. */
async function liveHosts(
  deps: Deps,
  refs: { collection: string; recordId: string }[],
): Promise<Map<string, LiveHost>> {
  const out = new Map<string, LiveHost>();
  const byCollection = new Map<string, string[]>();
  for (const r of refs) byCollection.set(r.collection, [...(byCollection.get(r.collection) ?? []), r.recordId]);

  const announcementIds = byCollection.get("announcements") ?? [];
  if (announcementIds.length) {
    const a = schema.announcements;
    const rows = await deps.db
      .select({ uuid: a.uuid, title: a.title, body: a.body, author: a.authorEmployeeId })
      .from(a)
      .where(and(inArray(a.uuid, announcementIds), isNull(a.deleteTime), eq(a.published, true), eq(a.disabled, false)));
    for (const r of rows) out.set(`announcements/${r.uuid}`, { title: r.title, body: r.body, author: r.author });
  }

  const suggestionIds = byCollection.get("suggestions") ?? [];
  if (suggestionIds.length) {
    const s = schema.suggestions;
    const rows = await deps.db
      .select({ uuid: s.uuid, title: s.title, body: s.body, author: s.submitterId, anonymous: s.anonymous })
      .from(s)
      .where(and(inArray(s.uuid, suggestionIds), isNull(s.deleteTime)));
    // The anonymity flag is read LIVE as well as stored on the payload, and the stricter of the two wins: a
    // post switched to anonymous after it was flagged must not stay named on the queue because the flag
    // remembers it was not.
    for (const r of rows) out.set(`suggestions/${r.uuid}`, { title: r.title, body: r.body, author: r.anonymous ? null : r.author });
  }
  return out;
}

function readPayload(raw: string): ModerationPayload | null {
  try {
    const v = JSON.parse(raw) as Partial<ModerationPayload>;
    if (!Array.isArray(v.hazards) || typeof v.excerpt !== "string") return null;
    return { hazards: v.hazards.map(String), excerpt: v.excerpt, anonymous: v.anonymous === true };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------

/**
 * Act on a flag.
 *
 * `hide` withdraws the post using the same column its own collection uses to withdraw one - `disabled` for an
 * announcement, which is half of `STATE_VISIBILITY`'s public test, and the soft-delete stamp for a suggestion,
 * which its list filter already honours. Neither is a hard delete, so the decision is reversible by the people
 * who can see the record, and the author is told.
 *
 * `dismiss` closes the flag and leaves the post exactly where it is. It is the expected answer: a guard model
 * on workplace kudos will object to things that are fine, and a queue nobody is allowed to disagree with is a
 * block list with extra steps.
 */
export async function decideModeration(
  deps: Deps,
  user: AppUser,
  host: string,
  action: ModerationAction,
): Promise<{ host: string; action: ModerationAction }> {
  const [collection, recordId] = splitHost(host);
  const flag = await deps.db
    .select({ uuid: schema.aiSuggestions.uuid, state: schema.aiSuggestions.state })
    .from(schema.aiSuggestions)
    .where(and(
      eq(schema.aiSuggestions.hostCollection, collection),
      eq(schema.aiSuggestions.hostRecordId, recordId),
      eq(schema.aiSuggestions.feature, FEATURE),
    ))
    .get();
  if (!flag) throw notFound("no moderation flag for that record");
  if (flag.state !== "pending") throw invalidArgument("that flag has already been decided");

  const now = deps.clock.now();
  if (action === "hide") await hideHost(deps, collection, recordId, user);

  await deps.db
    .update(schema.aiSuggestions)
    // `accepted` means the flag was upheld and the post came down; `rejected` means the moderator disagreed
    // with the model. Read against the other features' rows, both say the same thing: whether a human agreed.
    .set({ state: action === "hide" ? "accepted" : "rejected", decidedBy: user.uuid, decidedAt: now, updatedAt: now })
    .where(eq(schema.aiSuggestions.uuid, flag.uuid));

  return { host, action };
}

async function hideHost(deps: Deps, collection: string, recordId: string, user: AppUser): Promise<void> {
  const now = deps.clock.now();
  let author: string | null = null;
  let title = "";

  if (collection === "announcements") {
    const row = await deps.db
      .select({ title: schema.announcements.title, author: schema.announcements.authorEmployeeId })
      .from(schema.announcements)
      .where(and(eq(schema.announcements.uuid, recordId), isNull(schema.announcements.deleteTime)))
      .get();
    if (!row) throw notFound("that post is already gone");
    await deps.db.update(schema.announcements).set({ disabled: true, updatedAt: now }).where(eq(schema.announcements.uuid, recordId));
    author = row.author;
    title = row.title;
  } else {
    const row = await deps.db
      .select({ title: schema.suggestions.title, author: schema.suggestions.submitterId })
      .from(schema.suggestions)
      .where(and(eq(schema.suggestions.uuid, recordId), isNull(schema.suggestions.deleteTime)))
      .get();
    if (!row) throw notFound("that post is already gone");
    await deps.db.update(schema.suggestions).set({ deleteTime: now, updatedAt: now }).where(eq(schema.suggestions.uuid, recordId));
    author = row.author;
    title = row.title;
  }

  // The author is told, including when the post was anonymous: anonymity is a promise to readers about who
  // can see their name, not a reason to take somebody's post down without telling them. The moderator is
  // named as the actor for the same reason - a decision somebody has to answer for is not an anonymous one.
  //
  // `employeeId`, not `uuid`: both `recipient` and `actorId` are EMPLOYEE references (the notifications table
  // keys both to `employees.uuid`), and passing the user id instead fails the foreign key inside `notify`,
  // whose best-effort catch then swallows it - so the post comes down and nobody is told, silently. Null when
  // the moderator is an account with no employee record, which the column allows.
  if (author) {
    await notify(deps, {
      recipient: author,
      type: "moderation.hidden",
      title: "A post of yours was hidden",
      body: title ? `"${title}" is no longer visible on the wall.` : null,
      subject: `${collection}/${recordId}`,
      actorId: user.employeeId ?? null,
    });
  }
}

function splitHost(host: string): [string, string] {
  const [collection, recordId, ...rest] = host.split("/");
  if (!collection || !recordId || rest.length > 0) throw invalidArgument('host must read "<collection>/<id>"');
  if (!isModeratable(collection)) {
    throw invalidArgument(`"${collection}" is not a moderated collection (${Object.keys(MODERATABLE).join(", ")})`);
  }
  return [collection, recordId];
}

// ---------------------------------------------------------------------------------------------------------

/**
 * Llama Guard takes its taxonomy in the system prompt and answers in a fixed two-line shape. The instruction
 * is deliberately bare: this model is not being asked to reason, explain or suggest, and every extra sentence
 * here is an invitation to answer in prose that `parseVerdict` will then refuse.
 */
const SYSTEM = [
  "You are a content safety classifier for an internal workplace noticeboard.",
  "Decide whether the post between the <post> tags violates any hazard category.",
  "Answer with the single word 'safe', or the word 'unsafe' on one line followed by a second line of",
  "comma-separated category codes (for example: S5,S10).",
  "Answer with nothing else. Do not explain. Do not quote the post. Do not reply to it.",
].join("\n");

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
