import { eq, and, isNull, isNotNull, asc, inArray, sql } from "drizzle-orm";
import { allocOwnedCode, withFreshCode } from "./codeAlloc";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import type { ListScope } from "../domain/access";
import { addDaysUtc, addMonthsFromAnchor, advanceUntilAfter, seriesAnchorDay } from "../domain/calendar";
import { sum2 } from "../domain/money";
import { systemActor } from "../lib/systemActor";
import * as schema from "../db/schema";
import type { SetOf } from "./crud";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta, noteMeta } from "../lib/audit";
import { getDefaultDepartmentId } from "./settings";
import { orgToday, dayStartMs } from "./orgDay";
import { genId } from "../lib/idCodec";
import { invalidArgument, notFound, aborted, failedPrecondition, oneOf, isCodeCollision, isCardSeqCollision } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { deleteStateFilter, softDeleteRow, restoreRow, purgeRow, type PurgeCascade } from "./softDelete";
import { emitEvent } from "./eventBus";
import { updateGoalProgress } from "./goals";
import { notify } from "./notifications";
import { notifyMentions } from "./mentions";
import { parseColumns, commitmentIndex, columnIndex, normalizeLabelKeys, CARD_PRIORITIES, type CardPriority } from "../domain/boards";
import { runBatch, insertBatches, byIdChunks } from "../lib/dbBatch";
import { checkEtag, updateAtVersion } from "./versionGuard";

// Notify a card's assignee when they are newly assigned it (not a re-save to the same person, not self-assign).
async function notifyCardAssigned(deps: Deps, actor: AppUser, card: typeof schema.cards.$inferSelect, prevAssigneeId: string | null) {
  const to = card.assigneeId;
  if (!to || to === prevAssigneeId || to === actor.employeeId) return;
  const key = card.keyPrefix && card.seq ? `${card.keyPrefix}-${card.seq}: ` : "";
  await notify(deps, { recipient: to, type: "board.card_assigned", title: "Task assigned to you", body: `${key}${card.title}`, link: "boards", subject: `cards/${card.uuid}`, action: "respond", actorId: actor.employeeId });
}

const cardKeyOf = (card: { keyPrefix: string | null; seq: number | null }) =>
  card.keyPrefix && card.seq ? `${card.keyPrefix}-${card.seq}` : null;

/**
 * Tell a card's watchers something happened to it.
 *
 * Excludes the actor (nobody needs telling what they just did) and the assignee where they are already told
 * by the notification for that event, so watching a card you are assigned does not double it up. Watching is
 * opt-in and low priority by design: it is the "keep me posted" channel, not the "act on this" one, so these
 * land digestible where the recipient has a digest configured.
 */
async function notifyCardWatchers(
  deps: Deps,
  actor: AppUser,
  card: typeof schema.cards.$inferSelect,
  what: { type: string; title: string; body: string },
  alreadyTold: (string | null | undefined)[] = [],
) {
  const rows = await deps.db
    .select({ employeeId: schema.cardWatchers.employeeId })
    .from(schema.cardWatchers)
    .where(eq(schema.cardWatchers.cardId, card.uuid));
  const skip = new Set([actor.employeeId, ...alreadyTold].filter(Boolean) as string[]);
  const key = cardKeyOf(card);
  for (const r of rows) {
    if (skip.has(r.employeeId)) continue;
    await notify(deps, {
      recipient: r.employeeId,
      type: what.type,
      title: what.title,
      body: key ? `${key}: ${what.body}` : what.body,
      link: "boards",
      subject: `cards/${card.uuid}`,
      priority: "low",
      actorId: actor.employeeId,
    });
  }
}

/**
 * Watch / unwatch a card: hear about it without being the one doing it.
 *
 * Idempotent both ways (a unique index makes a second watch one row, and unwatching what you do not watch is
 * not an error), because these are toggles on a button and a double press is a double press, not a fault.
 * Anyone who can read the card may watch it - the verb is authorized on the card itself, so a watcher can
 * never be someone the board is closed to.
 */
export async function watchCard(deps: Deps, actor: AppUser, id: string, on: boolean) {
  const card = await getCard(deps, actor, id); // gate + existence
  if (!actor.employeeId) throw invalidArgument("only an employee can watch a task");
  if (on) {
    await deps.db.insert(schema.cardWatchers).values({ cardId: id, employeeId: actor.employeeId }).onConflictDoNothing();
  } else {
    await deps.db.delete(schema.cardWatchers).where(and(eq(schema.cardWatchers.cardId, id), eq(schema.cardWatchers.employeeId, actor.employeeId)));
  }
  // Deliberately unaudited: who is reading along is not a change to the work, and an audit entry per press
  // would bury the card's actual history under people subscribing and unsubscribing.
  return getCardWithComments(deps, actor, id);
}

// The actor for the nightly recurrence roll. The card it files was nobody's decision this morning - it is the
// cadence somebody set once - so the audit trail says so rather than crediting whoever last touched the
// series. (`createCard` reads `email` for the audit row and `employeeId` for "did the actor assign themselves",
// and a system actor correctly answers no to the second.)
//
// `systemActor()` (lib/systemActor.ts), not a locally cast `{ email: "…" } as unknown as AppUser`. That cast
// is a promise about which fields the whole call tree reads, made in a file that cannot see the call tree: it
// held only while `audit()` happened to touch email/employeeId/name/role, it left `actor_role` null on every
// row this wrote, and the day anything downstream reads another field it is `undefined` at runtime with the
// types saying otherwise. One honest system identity, shared with the automation engine and internal dispatch.
const SYSTEM_ACTOR = systemActor();

/**
 * File the next card in every delivered recurring series - the nightly tick's half of `cadence`.
 *
 * Repeating operational work (the weekly compliance sweep, the monthly access review, the quarterly restore
 * test) had to be retyped twelve times a year, and the one that got forgotten was invisible: there is no card,
 * so there is nothing on the board to notice the absence of.
 *
 * Rolls on DELIVERY, not on a date: a chore that is a week late does not want a second copy of itself filed
 * on top of it, and the delivered card is the signal that the cycle is actually finished. The cadence MOVES to
 * the new card (claimed with a conditional update, so two ticks racing can only produce one), which keeps
 * exactly one live card per series - the same invariant recurring 1:1s run on.
 *
 * Carried over: title, description, assignee, department, priority, size, labels and the checklist, unticked -
 * everything that makes it the same chore. Deliberately not carried: the linked GOAL (a series would inflate
 * that goal's task count forever) and the SPRINT (a time box the next one is not in).
 */
/** How many delivered series one tick rolls. See the note on the slice below for why there is a cap at all. */
const MAX_ROLLS_PER_TICK = 15;

export async function rollRecurringCards(deps: Deps): Promise<number> {
  // The board is JOINED, and live-only, for a reason the claim below makes sharp: soft-deleting a board does
  // not touch its cards (boards have no `remove` override - see routes/boards.ts), so a delivered recurring
  // card on a deleted board stayed in this query while `createCard` refuses it with "board not found". The
  // series was then claimed - its cadence cleared - and the create it was claimed for threw, which is the one
  // outcome that cannot be undone by the next tick. Filtered out here instead, the series lies dormant with
  // its cadence intact and rolls again if the board is restored.
  const due = (await deps.db
    .select()
    .from(schema.cards)
    .innerJoin(schema.boards, eq(schema.cards.boardId, schema.boards.uuid))
    .where(and(
      isNull(schema.cards.deleteTime),
      isNull(schema.boards.deleteTime),
      isNotNull(schema.cards.cadence),
      isNotNull(schema.cards.deliveredAt),
    ))
    .orderBy(asc(schema.cards.deliveredAt), asc(schema.cards.uuid))).map((r) => r.cards);
  // CAPPED PER TICK, for the reason the recurring-expense sweep is (services/expenses.ts): each series below
  // costs the better part of a dozen subrequests - the claim, the checklist read, the create, the anchor and
  // reporter stamps, the watcher insert, the landed check - and none of it batches, because the claim decides
  // whether the create happens at all. Unbounded, a board with many delivered series would spend the
  // invocation's whole subrequest budget (lib/dbBatch.ts) in the nightly tick and take every subtask after it
  // down with it. A deferred series keeps its `cadence`, so it is still claimable and the next tick rolls it;
  // oldest delivery first, so a long backlog drains in order rather than starving.
  const rows = due.slice(0, MAX_ROLLS_PER_TICK);
  const deferred = due.length - rows.length;
  if (deferred > 0) console.warn(`[cards] ${deferred} recurring series deferred to the next tick (cap ${MAX_ROLLS_PER_TICK})`);
  // The ORG's calendar day, anchored at UTC midnight - `advanceUntilAfter` reads it with getUTC* below, so
  // this anchor is the day the org is actually living in. The tick fires at 02:00 UTC, which is the previous
  // evening west of UTC, and a UTC-derived "today" therefore filed the next occurrence a day early there.
  const today = new Date(dayStartMs(await orgToday(deps)));
  let rolled = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.cadence) continue;
    // The next due date measured from the old one, so a series keeps its rhythm rather than drifting by
    // however late the last one was delivered. With no due date there is no rhythm to keep, and the delivery
    // date is the only honest anchor.
    //
    // Stepped until it is actually in the FUTURE (`advanceUntilAfter`, the same shape rollRecurringCheckIns
    // uses). One step off the old due date is only the next occurrence while the series is being kept up
    // with: a weekly chore due the 5th and delivered on the 1st of the next month got its replacement filed
    // due the 12th - born three weeks overdue - and every occurrence after it inherited that lag. Month steps
    // clamp the day (domain/calendar.ts), so a monthly chore on the 31st goes to 28 February instead of
    // rolling over to 3 March and skipping the month.
    const from = new Date(+new Date(r.dueDate ?? r.deliveredAt!));
    const cadence = r.cadence;
    // The series' day of the month, carried onto the successor below. The clamp above lands a 31st series on
    // 28 February, and stepping from THERE next month kept the 28th - so a monthly access review written for
    // the 31st spent the rest of its life three days early. The anchor puts it back on the 31st in March.
    const anchorDay = seriesAnchorDay(from, r.cadenceAnchorDay);
    const next = advanceUntilAfter(from, today, (d) =>
      cadence === "monthly" ? addMonthsFromAnchor(d, 1, anchorDay)
        : cadence === "quarterly" ? addMonthsFromAnchor(d, 3, anchorDay)
        : addDaysUtc(d, cadence === "weekly" ? 7 : 14));

    // Claim the series: clearing the cadence under a WHERE that still sees it means a second tick (or another
    // worker) finds nothing to claim and files no duplicate.
    const claimed = await deps.db
      .update(schema.cards)
      .set({ cadence: null, updatedAt: new Date() })
      .where(and(eq(schema.cards.uuid, r.uuid), eq(schema.cards.cadence, r.cadence)))
      .returning();
    if (!claimed.length) continue;

    // The new card's id is minted HERE rather than by the insert, so the failure path below can ask whether it
    // landed. Without that it cannot: `createCard` does several writes after the row itself (the movement, the
    // checklist, the audit entry), and a throw from one of those leaves a card that already carries the
    // cadence - releasing the old one as well would put the series on two cards and the next tick would file a
    // duplicate of a chore that is meant to exist once.
    const nextId = genId();
    try {
      const todos = await deps.db
        .select({ text: schema.cardTodos.text })
        .from(schema.cardTodos)
        .where(eq(schema.cardTodos.cardId, r.uuid))
        .orderBy(asc(schema.cardTodos.createdAt));
      const created = await createCard(deps, SYSTEM_ACTOR, {
        board: `boards/${r.boardId}`,
        employee: `employees/${r.employeeId}`,
        title: r.title,
        description: r.description,
        assignee: r.assigneeId ? `employees/${r.assigneeId}` : null,
        ...(r.departmentId ? { department: `departments/${r.departmentId}` } : { department: null }),
        priority: r.priority,
        size: r.size,
        labels: (() => { try { return JSON.parse(r.labelsJson) as string[]; } catch { return []; } })(),
        due_date: next.toISOString().slice(0, 10),
        cadence: r.cadence,
        initial_todos: todos.map((t) => t.text),
      }, nextId);
      // The series' day travels with the cadence, onto the one card that carries it. Written here rather than
      // through `CardInput` because it is not something a caller of `createCard` ever sets - it is bookkeeping
      // the roll owns, the same way the reporter below is.
      await deps.db.update(schema.cards).set({ cadenceAnchorDay: anchorDay }).where(eq(schema.cards.uuid, created.uuid));
      // The reporter carries down the series. `createCard` stamps the ACTOR, which here is the nightly tick and
      // nobody - but the chore was filed by a person, and the next instance of it is not suddenly nobody's.
      if (r.reporterId) {
        await deps.db.update(schema.cards).set({ reporterId: r.reporterId }).where(eq(schema.cards.uuid, created.uuid));
        await deps.db.insert(schema.cardWatchers).values({ cardId: created.uuid, employeeId: r.reporterId }).onConflictDoNothing();
      }
      if (created.assigneeId) {
        const key = cardKeyOf(created);
        await notify(deps, {
          recipient: created.assigneeId,
          type: "board.card_assigned",
          title: "Recurring task filed",
          body: `${key ? `${key}: ` : ""}${created.title} - due ${next.toISOString().slice(0, 10)}`,
          link: "boards",
          subject: `cards/${created.uuid}`,
          action: "respond",
        });
      }
      rolled++;
    } catch (err) {
      // The create failed AFTER the claim took the cadence off the old card, so put it back: the series is
      // retried on the next tick instead of ending here. Claim-and-then-swallow meant a repeating chore the
      // org set up simply stopped existing, with nothing anywhere saying so - and a chore that silently stops
      // is worse than one that is late, because the board shows no card to notice the absence of.
      //
      // Unless the successor actually landed first: it carries the cadence now, so the series is intact and
      // putting it back on the old card as well would hand the next tick two copies of one chore. Only a
      // series with nowhere to continue gets its claim back.
      //
      // Guarded on the value this run wrote (cadence now NULL), so releasing cannot stamp over a cadence
      // somebody has since set by hand - the same guard shape as the claim itself.
      const landed = (await deps.db.select({ uuid: schema.cards.uuid }).from(schema.cards).where(eq(schema.cards.uuid, nextId)).limit(1))[0];
      if (!landed) {
        await deps.db
          .update(schema.cards)
          .set({ cadence: r.cadence, cadenceAnchorDay: r.cadenceAnchorDay, updatedAt: new Date() })
          .where(and(eq(schema.cards.uuid, r.uuid), isNull(schema.cards.cadence)));
      }
      failed++;
      console.error(`[cards] recurring roll failed for card ${r.uuid}; claim released for retry`, err);
    }
  }
  // Loudly, not into a log nobody reads: the cron subtask wrapper turns this into a `cron_runs` failure, so a
  // night that could not file a recurring task shows as a failed tick in the Operations UI. Thrown only after
  // every OTHER series has had its turn - one bad card must not cost the rest of the board their roll.
  if (failed) throw new Error(`${failed} recurring task(s) could not be filed (${rolled} succeeded); each claim was released for the next tick`);
  return rolled;
}

/** The watchers on a page of cards, in one query - so a board can show the eye without a read per card. */
export async function watchersFor(deps: Deps, cardIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!cardIds.length) return out;
  // Chunked: a full board page is `clampPageSize` = 100 ids, which is the D1 bound-parameter cap exactly, with
  // nothing left for a predicate beside it. See lib/dbBatch.ts ID_CHUNK.
  const rows = await byIdChunks(cardIds, (group) =>
    deps.db
      .select({ cardId: schema.cardWatchers.cardId, employeeId: schema.cardWatchers.employeeId })
      .from(schema.cardWatchers)
      .where(inArray(schema.cardWatchers.cardId, group)),
  );
  for (const r of rows) (out.get(r.cardId) ?? out.set(r.cardId, []).get(r.cardId)!).push(r.employeeId);
  return out;
}

export type CardInput = {
  board?: string;
  sprint?: string | null;
  employee?: string | null;
  department?: string | null; // the card's department; omit to default to the org default, null to clear
  column_key?: string;
  swimlane_key?: string | null;
  rank?: number;
  title?: string;
  description?: string | null;
  assignee?: string | null;
  priority?: CardPriority;
  labels?: unknown;
  documents?: string[]; // org-document refs to link (link-only; replaces the whole set on patch)
  size?: number | null;
  due_date?: string | null;
  goal?: string | null;
  cadence?: CardCadence | null; // repeating work: the next one is filed when this card is delivered
  initial_todos?: string[]; // checklist items to seed at creation (create dialog: custom items + any template)
};
export type CardCadence = NonNullable<typeof schema.cards.$inferSelect["cadence"]>;
const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);
const dayMs = (s?: string | null) => (s ? Date.parse(s + "T00:00:00Z") : NaN);

// Cards in a board column (non-deleted), for WIP counting + rank append. Optionally excluding one card.
/**
 * The next rank at the bottom of a column, and the next per-board `seq`, as AGGREGATES.
 *
 * Both were `reduce(Math.max)` over every row: `columnCards(...)` for the rank and a bare
 * `select seq from cards where board_id = ?` for the sequence. That is the shape services/codeAlloc.ts was
 * rewritten out of, in its own words - "fine on a bounded table and ruinous on an append-only one … composing
 * one code came to mean reading every event ever recorded, per action, on a platform that bills rows read".
 * A board is not bounded: finished cards stay for the history and the CFD analytics, so a mature board billed
 * its whole card count on every new card - and the `seq` read sat INSIDE `withFreshCode`, so a contended
 * board paid for it up to four times in one request.
 *
 * `max()` is one row instead of N, and index-backed in both cases (`card_board_seq_idx` on (board_id, seq),
 * `card_board_idx` on board_id). The allocation rule is unchanged - still max+1 read-then-write, still caught
 * by the unique index and retried by `withFreshCode` - so nothing about the collision story moves.
 */
const RANK_STEP = 1024;
async function nextRank(deps: Deps, boardId: string, columnKey: string): Promise<number> {
  const [r] = await deps.db
    .select({ max: sql<number | null>`max(${schema.cards.rank})` })
    .from(schema.cards)
    .where(and(eq(schema.cards.boardId, boardId), eq(schema.cards.columnKey, columnKey), isNull(schema.cards.deleteTime)));
  return (r?.max ?? 0) + RANK_STEP;
}

/** Deleted cards are deliberately counted: a seq is a human key (MS-4) and must never be handed out twice. */
async function nextSeq(deps: Deps, boardId: string): Promise<number> {
  const [r] = await deps.db
    .select({ max: sql<number | null>`max(${schema.cards.seq})` })
    .from(schema.cards)
    .where(eq(schema.cards.boardId, boardId));
  return (r?.max ?? 0) + 1;
}

async function columnCards(deps: Deps, boardId: string, columnKey: string) {
  return deps.db
    .select({ uuid: schema.cards.uuid, rank: schema.cards.rank, assigneeId: schema.cards.assigneeId })
    .from(schema.cards)
    .where(and(eq(schema.cards.boardId, boardId), eq(schema.cards.columnKey, columnKey), isNull(schema.cards.deleteTime)));
}

export async function listCards(deps: Deps, scope: ListScope, maxPageSize: number, pageToken?: string, boardId?: string, showDeleted = false, deletedOnly = false, assigneeId?: string) {
  const conds = [applyScope(scope, schema.cards.code, schema.cards.employeeId)];
  if (boardId) conds.push(eq(schema.cards.boardId, boardId));
  // The work one person is doing, across every board - the profile's Performance tab. Filtered on the
  // ASSIGNEE, not on `employee_id`: the owner is who the row is authz-scoped by, and on a task a manager filed
  // for somebody else the two are the same person while on a task pulled off a team backlog they are not.
  if (assigneeId) conds.push(eq(schema.cards.assigneeId, assigneeId));
  conds.push(deleteStateFilter(schema.cards.deleteTime, showDeleted, deletedOnly));
  const page = await keysetPage<typeof schema.cards.$inferSelect>(deps, schema.cards, "cards", and(...conds.filter(Boolean)), { max: maxPageSize, pageToken });
  // Attach compact checklist progress (done/total) per row so the board tile shows it without loading items.
  // One grouped read over just this page's cards keeps it cheap.
  const ids = page.items.map((r) => r.uuid);
  if (ids.length) {
    const todoRows = await byIdChunks(ids, (group) =>
      deps.db.select({ cardId: schema.cardTodos.cardId, done: schema.cardTodos.done }).from(schema.cardTodos).where(inArray(schema.cardTodos.cardId, group)),
    );
    const agg = new Map<string, { total: number; done: number }>();
    for (const r of todoRows) {
      const a = agg.get(r.cardId) ?? { total: 0, done: 0 };
      a.total++;
      if (r.done) a.done++;
      agg.set(r.cardId, a);
    }
    for (const row of page.items) {
      const a = agg.get(row.uuid);
      (row as typeof row & { todoTotal: number; todoDone: number }).todoTotal = a?.total ?? 0;
      (row as typeof row & { todoTotal: number; todoDone: number }).todoDone = a?.done ?? 0;
    }
  }
  return page;
}

export async function getCard(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.cards).where(eq(schema.cards.uuid, id)).limit(1))[0];
  if (!row) throw notFound("card not found");
  return row;
}

// A card plus its threaded comments + checklist (both oldest-first), for the Get route + after a mutation.
export async function getCardWithComments(deps: Deps, actor: AppUser, id: string) {
  const row = await getCard(deps, actor, id);
  const comments = await deps.db.select().from(schema.cardComments).where(eq(schema.cardComments.cardId, id)).orderBy(asc(schema.cardComments.createdAt));
  const todos = await deps.db.select().from(schema.cardTodos).where(eq(schema.cardTodos.cardId, id)).orderBy(asc(schema.cardTodos.createdAt));
  const watchers = (await deps.db.select({ employeeId: schema.cardWatchers.employeeId }).from(schema.cardWatchers).where(eq(schema.cardWatchers.cardId, id))).map((w) => w.employeeId);
  // Approved hours booked against this task. Only APPROVED time counts, for the same reason the goal's hours
  // do: a draft entry is somebody's intention, not effort the org has agreed was spent. Undefined rather than
  // 0 when nothing is booked - "no timesheet names this task" is not "this task took no time".
  const hourRows = await deps.db
    .select({ hours: schema.timeEntries.hours })
    .from(schema.timeEntries)
    .where(and(eq(schema.timeEntries.cardId, id), eq(schema.timeEntries.status, "APPROVED"), isNull(schema.timeEntries.deleteTime)));
  // `sum2`, not an inline `Math.round(sum * 100) / 100`: hours are a `real` column under the same rounding
  // rule as money (domain/money.ts is the one helper for both), and the inline form multiplies in float, so a
  // decimal half-case rounds the wrong way. It also disagreed with the goal roll-up, which rounded the same
  // timesheet hours to ONE place - so one task's effort read 7.53 here and 7.5 there.
  const hours = hourRows.length ? sum2(hourRows.map((h) => h.hours ?? 0)) : undefined;
  return { ...row, _comments: comments, _todos: todos, _watchers: watchers, _hours: hours };
}

export async function commentCard(deps: Deps, actor: AppUser, id: string, body?: string | null) {
  const card = await getCard(deps, actor, id); // gate + existence (the middleware already authorized the verb on this card)
  const text = (body ?? "").trim();
  if (!text) throw invalidArgument("a comment body is required");
  await deps.db.insert(schema.cardComments).values({ cardId: id, authorId: actor.employeeId ?? null, authorEmail: actor.email, body: text });
  await audit(deps, actor, "card.comment", "cards", id, noteMeta("cards", text), card);
  // Naming someone in a comment is how work gets handed over on a board, so it tells them. A mention is a
  // notification and nothing more: if they cannot see this board, they still cannot - see services/mentions.ts.
  await notifyMentions(deps, actor, { subject: `cards/${id}`, link: "boards", type: "board.mention", body: text, title: card.title });
  // Commenting is the event a watcher most wants: it is where the reason behind a move gets written down.
  await notifyCardWatchers(deps, actor, card, {
    type: "board.card_comment",
    title: "New comment on a task you watch",
    body: text.length > 140 ? `${text.slice(0, 140)}…` : text,
  });
  // Whoever joins a card's conversation is watching it from then on. Doing this by hand is the step everybody
  // forgets, and then wonders why they missed the reply to their own question.
  if (actor.employeeId) {
    await deps.db.insert(schema.cardWatchers).values({ cardId: id, employeeId: actor.employeeId }).onConflictDoNothing();
  }
  return getCardWithComments(deps, actor, id);
}

// Touch the card's update_time so checklist activity surfaces it as recently active, mirroring comments.
async function touchCard(deps: Deps, id: string) {
  await deps.db.update(schema.cards).set({ updatedAt: new Date() }).where(eq(schema.cards.uuid, id));
}

// Add one or more checklist items. The web sends a single item from the input box, or a whole predefined
// checklist's item texts when one is applied - snapshotted onto the card either way. Applying a template is
// gated upstream (the picker only lists ticket-checklists the caller can read), so no template lookup here.
export async function addCardTodos(deps: Deps, actor: AppUser, id: string, texts?: string[]) {
  await getCard(deps, actor, id); // gate + existence
  const items = (texts ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
  if (!items.length) throw invalidArgument("a checklist item is required");
  // `insertBatches`, not one statement: a checklist row binds six parameters, so a single multi-row insert
  // runs out of D1's hundred at seventeen items - and applying a predefined checklist is exactly the path
  // that arrives with a long list.
  await runBatch(deps.db, insertBatches(items.map((text) => ({ cardId: id, text })), (group) => deps.db.insert(schema.cardTodos).values(group)));
  await touchCard(deps, id);
  await audit(deps, actor, "card.addTodos", "cards", id, { fields: items.slice(0, 12) });
  return getCardWithComments(deps, actor, id);
}

export async function toggleCardTodo(deps: Deps, actor: AppUser, id: string, todoId?: string | null, done?: boolean) {
  await getCard(deps, actor, id);
  const tid = todoId ? todoId.split("/").pop()! : "";
  if (!tid) throw invalidArgument("a checklist item id is required");
  const item = (await deps.db.select().from(schema.cardTodos).where(and(eq(schema.cardTodos.uuid, tid), eq(schema.cardTodos.cardId, id))).limit(1))[0];
  if (!item) throw notFound("checklist item not found");
  await deps.db.update(schema.cardTodos).set({ done: !!done, updatedAt: new Date() }).where(eq(schema.cardTodos.uuid, tid));
  await touchCard(deps, id);
  await audit(deps, actor, "card.toggleTodo", "cards", id, { note: item.text, diff: { done: { from: item.done, to: !!done } } });
  return getCardWithComments(deps, actor, id);
}

export async function removeCardTodo(deps: Deps, actor: AppUser, id: string, todoId?: string | null) {
  await getCard(deps, actor, id);
  const tid = todoId ? todoId.split("/").pop()! : "";
  if (!tid) throw invalidArgument("a checklist item id is required");
  const item = (await deps.db.select().from(schema.cardTodos).where(and(eq(schema.cardTodos.uuid, tid), eq(schema.cardTodos.cardId, id))).limit(1))[0];
  if (!item) throw notFound("checklist item not found");
  await deps.db.delete(schema.cardTodos).where(eq(schema.cardTodos.uuid, tid));
  await touchCard(deps, id);
  await audit(deps, actor, "card.removeTodo", "cards", id, { note: item.text });
  return getCardWithComments(deps, actor, id);
}

/**
 * Promote a checklist item into a card of its own: the item that turned out to be real work.
 *
 * A checklist is deliberately cheap - a line of text and a tick - and that is right until one line grows an
 * estimate, a different assignee and a due date of its own. Until now that meant retyping it as a card and
 * remembering to tick the original, which is exactly the kind of double bookkeeping that ends with a board
 * and a checklist disagreeing about what is outstanding.
 *
 * What it does, and what it deliberately does not:
 *  - the new card lands on the SAME board, in its first column, carrying the parent's department, sprint and
 *    (by default) assignee, so it appears where the rest of that work lives rather than in a stray backlog;
 *  - the parent's `goal` is NOT copied. The parent card is still linked and still counts towards the goal's
 *    delivered share; copying it would count one piece of work twice in the roll-up;
 *  - the item is ticked and its text gains the new card's key, so the checklist reads as a pointer to where
 *    the work went instead of a phantom done item;
 *  - no dependency is written. The parent is not "blocked" in the WIP sense by work it just handed off, and
 *    `blocked_by` holds one card - spending it here would clobber a real dependency.
 */
export async function promoteCardTodo(deps: Deps, actor: AppUser, id: string, todoId?: string | null, assignee?: string | null) {
  const parent = await getCard(deps, actor, id); // gate + existence
  const tid = todoId ? todoId.split("/").pop()! : "";
  if (!tid) throw invalidArgument("a checklist item id is required");
  const item = (await deps.db.select().from(schema.cardTodos).where(and(eq(schema.cardTodos.uuid, tid), eq(schema.cardTodos.cardId, id))).limit(1))[0];
  if (!item) throw notFound("checklist item not found");
  const parentKey = parent.keyPrefix && parent.seq ? `${parent.keyPrefix}-${parent.seq}` : null;

  const child = await createCard(deps, actor, {
    board: `boards/${parent.boardId}`,
    title: item.text,
    description: `Promoted from ${parentKey ? `${parentKey} ` : ""}“${parent.title}”.`,
    // `assignee` explicitly null clears it; omitted inherits the parent's, which is whose list the item was
    // sitting on a minute ago.
    assignee: assignee === undefined ? (parent.assigneeId ? `employees/${parent.assigneeId}` : null) : assignee,
    ...(parent.departmentId ? { department: `departments/${parent.departmentId}` } : {}),
    ...(parent.sprintId ? { sprint: `sprints/${parent.sprintId}` } : {}),
  });
  const childKey = child.keyPrefix && child.seq ? `${child.keyPrefix}-${child.seq}` : null;

  await deps.db
    .update(schema.cardTodos)
    .set({ done: true, text: childKey ? `${item.text} → ${childKey}` : item.text, updatedAt: new Date() })
    .where(eq(schema.cardTodos.uuid, tid));
  await touchCard(deps, id);
  await audit(deps, actor, "card.promoteTodo", "cards", id, {
    note: childKey ? `${item.text} → ${childKey}` : item.text,
    card: `cards/${child.uuid}`,
  }, parent);
  return getCardWithComments(deps, actor, id);
}

export async function createCard(deps: Deps, actor: AppUser, input: CardInput, id?: string) {
  if (!input.title?.trim()) throw invalidArgument("title is required");
  const title = input.title.trim();
  const boardId = idFromPath(input.board);
  if (!boardId) throw invalidArgument("board is required");
  const board = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, boardId)).limit(1))[0];
  if (!board || board.deleteTime) throw notFound("board not found");
  const cols = parseColumns(board.columnsJson);
  if (!cols.length) throw failedPrecondition("the board has no columns yet");
  const columnKey = input.column_key ?? cols[0]!.key;
  if (columnIndex(cols, columnKey) < 0) throw invalidArgument("column_key is not a column on this board");
  const employeeId = idFromPath(input.employee) ?? actor.employeeId;
  if (!employeeId) throw invalidArgument("employee is required");
  // Department: explicit value (incl. null) wins; when the key is omitted, fall back to the org default.
  const departmentId = "department" in input ? (idFromPath(input.department) ?? null) : await getDefaultDepartmentId(deps);
  if (input.priority && !CARD_PRIORITIES.includes(input.priority)) throw invalidArgument("priority is invalid");
  const due = dayMs(input.due_date);
  if (input.due_date && Number.isNaN(due)) throw invalidArgument("due_date is invalid");
  // Append to the end of the target column unless a rank was supplied.
  const rank = input.rank ?? (await nextRank(deps, boardId, columnKey));
  // Both of the card's allocated numbers are read-then-write max+1: its `code` and the per-board `seq` behind
  // the human key (MS-1, MS-2…). Two people filing a task on the same board at the same moment therefore
  // compose the same pair, and the unique indexes fail the loser rather than let two tasks answer to MS-4.
  // Allocating INSIDE the retry is what makes that recoverable: the second look sees the winner's row and
  // takes the next numbers. Prefix is copied from the board so the key survives a later prefix change.
  const row = (await withFreshCode(async () => {
    const seq = await nextSeq(deps, boardId);
    const code = await allocOwnedCode(deps, schema.cards, schema.cards.employeeId, employeeId);
    return deps.db
    .insert(schema.cards)
    .values({
      code,
      ...(id ? { uuid: id } : {}),
      boardId,
      seq,
      keyPrefix: board.taskPrefix || null,
      sprintId: idFromPath(input.sprint) ?? null,
      employeeId,
      // Who filed it - the actor, always, and never what the caller says. A reporter a client could set is a
      // reporter anybody can put somebody else's name on.
      reporterId: actor.employeeId ?? null,
      columnKey,
      departmentId,
      swimlaneKey: idFromPath(input.swimlane_key) ?? (input.swimlane_key?.trim() || null),
      rank,
      title,
      description: input.description?.trim() || null,
      assigneeId: idFromPath(input.assignee) ?? null,
      priority: input.priority ?? "medium",
      labelsJson: JSON.stringify(normalizeLabelKeys(input.labels ?? [])),
      documentsJson: JSON.stringify((input.documents ?? []).map((p) => idFromPath(p)).filter(Boolean)),
      size: input.size ?? null,
      dueDate: input.due_date ? new Date(due) : null,
      goalId: idFromPath(input.goal) ?? null,
      cadence: input.cadence ?? null,
    })
    .returning();
  }, (e) => isCodeCollision(e) || isCardSeqCollision(e)))[0]!;
  await deps.db.insert(schema.cardMovements).values({ cardId: row.uuid, boardId, fromColumn: null, toColumn: columnKey, actorId: actor.employeeId ?? null });
  // Optional checklist seeded at creation (custom items and/or a template the dialog expanded to texts).
  const initialTodos = (input.initial_todos ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
  if (initialTodos.length) {
    await runBatch(deps.db, insertBatches(initialTodos.map((text) => ({ cardId: row.uuid, text })), (group) => deps.db.insert(schema.cardTodos).values(group)));
  }
  await audit(deps, actor, "card.create", "cards", row.uuid, createdMeta(row, "cards"), row);
  // Whoever filed a task follows it from then on. Filing work for somebody else is precisely the case where
  // "how is that going" gets asked, and the reporter is the one person guaranteed to want the answer -
  // notifications skip the actor, so this costs them nothing on their own tasks.
  if (row.reporterId) {
    await deps.db.insert(schema.cardWatchers).values({ cardId: row.uuid, employeeId: row.reporterId }).onConflictDoNothing();
  }
  await notifyCardAssigned(deps, actor, row, null);
  await emitEvent(deps, actor, "card.created", { subject: `cards/${row.uuid}`, employeeId, payload: { board: `boards/${boardId}`, column: columnKey, priority: row.priority } });
  await recomputeGoalProgress(deps, actor, row.goalId); // a new linked task lowers its goal's delivered share
  return row;
}

export async function updateCard(deps: Deps, actor: AppUser, id: string, patch: CardInput, ifMatch?: string) {
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  checkEtag(row, ifMatch);
  const set: SetOf<typeof schema.cards> = { updatedAt: new Date() };
  const has = (k: keyof CardInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("title")) {
    if (!patch.title?.trim()) throw invalidArgument("title is required");
    set.title = patch.title.trim();
  }
  if (has("description")) set.description = patch.description?.trim() || null;
  if (has("swimlane_key")) set.swimlaneKey = patch.swimlane_key || null;
  if (has("department")) set.departmentId = idFromPath(patch.department) ?? null;
  if (has("sprint")) set.sprintId = idFromPath(patch.sprint) ?? null; // move a card between the backlog and a sprint
  if (has("assignee")) set.assigneeId = idFromPath(patch.assignee) ?? null;
  if (has("priority")) {
    if (patch.priority && !CARD_PRIORITIES.includes(patch.priority)) throw invalidArgument("priority is invalid");
    set.priority = patch.priority;
  }
  if (has("labels")) set.labelsJson = JSON.stringify(normalizeLabelKeys(patch.labels ?? []));
  if (has("documents")) set.documentsJson = JSON.stringify((patch.documents ?? []).map((p) => idFromPath(p)).filter(Boolean));
  if (has("size")) set.size = patch.size ?? null;
  if (has("due_date")) {
    const due = dayMs(patch.due_date);
    if (patch.due_date && Number.isNaN(due)) throw invalidArgument("due_date is invalid");
    set.dueDate = patch.due_date ? new Date(due) : null;
  }
  if (has("goal")) set.goalId = idFromPath(patch.goal) ?? null;
  if (has("cadence")) set.cadence = patch.cadence ?? null;
  const oldGoalId = row.goalId;
  const updated = await updateAtVersion(deps, schema.cards, "card", row, set);
  // `diffMeta(..., "cards")` rather than a bare field diff: naming the collection is what turns the FK columns
  // (assignee, department, sprint, goal) into `<collection>/<id>` refs instead of the raw internal ids they are
  // in the row - an internal id must not reach the wire, and a ref is what the feed resolves to a NAME. It also
  // reports the label/document blobs as `changed` instead of dumping them into the diff.
  await audit(deps, actor, "card.update", "cards", id, diffMeta(row, updated, set, "cards"));
  if (has("assignee")) await notifyCardAssigned(deps, actor, updated, row.assigneeId);
  // Recompute the new goal (size/reassign may change its roll-up) and, if the link moved, the old goal too.
  await recomputeGoalProgress(deps, actor, updated.goalId);
  if (oldGoalId && oldGoalId !== updated.goalId) await recomputeGoalProgress(deps, actor, oldGoalId);
  return updated;
}

// The pull action. Moves a card to `toColumn` (optionally a swimlane + explicit rank), enforcing the destination
// column's WIP limit server-side, stamping the commitment/started/delivery timestamps the first time the card
// crosses those points, appending a movement, and (if the board opts in) rolling a delivered card up to its goal.
// Where a move is sending the card. Every field except `column` is optional, and the difference between
// ABSENT and null is load-bearing: absent means "this move does not touch that field", null means "clear it"
// (drop the swimlane, unassign, send back to the backlog). A positional parameter list could not hold that
// distinction safely - five adjacent `string | null | undefined` arguments type-check in any order, so a
// transposed pair silently moved the wrong field.
export type MoveCardTarget = {
  column: string;
  swimlane?: string | null;
  rank?: number;
  assignee?: string | null;
  goal?: string | null;
  priority?: string | null;
  department?: string | null;
  sprint?: string | null;
};

export async function moveCard(deps: Deps, actor: AppUser, id: string, to: MoveCardTarget, ifMatch?: string) {
  const { column: toColumn, swimlane: toSwimlane, rank, assignee: toAssignee, goal: toGoal, priority: toPriority, department: toDepartment, sprint: toSprint } = to;
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  // The SPA has always sent the card's ETag with a move (`invoke(..., "move", card.etag, move)`), and the
  // sibling verbs on this collection take one; `move` alone discarded it, so the client was being careful
  // about a version the server ignored.
  checkEtag(row, ifMatch);
  const board = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, row.boardId)).limit(1))[0];
  if (!board) throw notFound("board not found");
  const cols = parseColumns(board.columnsJson);
  const destIdx = columnIndex(cols, toColumn);
  if (destIdx < 0) throw invalidArgument("toColumn is not a column on this board");
  const dest = cols[destIdx]!;
  const changingColumn = toColumn !== row.columnKey;

  // WIP: block pulling INTO a column that is already at its limit (moving within/out is always allowed).
  // Board-wide by default; per-assignee counts only the moving card's assignee's cards in that column.
  if (changingColumn && dest.wipLimit != null) {
    const inCol = await columnCards(deps, row.boardId, toColumn);
    const perAssignee = dest.limitScope === "assignee";
    const count = perAssignee ? inCol.filter((c) => (c.assigneeId ?? null) === (row.assigneeId ?? null)).length : inCol.length;
    if (count >= dest.wipLimit) {
      throw failedPrecondition(
        perAssignee
          ? `${row.assigneeId ? "the assignee" : "unassigned work"} already has ${dest.wipLimit} card(s) in "${dest.label}"`
          : `"${dest.label}" is at its WIP limit (${dest.wipLimit})`,
      );
    }
  }

  const now = new Date();
  const set: SetOf<typeof schema.cards> = { columnKey: toColumn, updatedAt: now };
  if (toSwimlane !== undefined) set.swimlaneKey = idFromPath(toSwimlane) ?? toSwimlane ?? null;
  // Derived swimlanes (assignee/goal) are real card fields — dragging a card into another such lane reassigns them.
  const changingAssignee = toAssignee !== undefined && (idFromPath(toAssignee) ?? null) !== (row.assigneeId ?? null);
  const changingGoal = toGoal !== undefined && (idFromPath(toGoal) ?? null) !== (row.goalId ?? null);
  if (toAssignee !== undefined) set.assigneeId = idFromPath(toAssignee) ?? null;
  if (toGoal !== undefined) set.goalId = idFromPath(toGoal) ?? null;
  // priority is a required enum - a NONE lane drop leaves it unchanged
  if (toPriority) set.priority = oneOf(toPriority, CARD_PRIORITIES, "priority is invalid");
  if (toDepartment !== undefined) set.departmentId = idFromPath(toDepartment) ?? null;
  // Backlog <-> sprint in the same atomic move (null = backlog), same semantics as PATCH `sprint`.
  if (toSprint !== undefined) set.sprintId = idFromPath(toSprint) ?? null;
  if (rank != null) set.rank = rank;
  else if (changingColumn) set.rank = await nextRank(deps, row.boardId, toColumn);

  // Flow timestamps (stamped once, the first crossing). committed = at/after the commitment column; started =
  // past the commitment column (real work); delivered = the delivery column.
  const commitIdx = commitmentIndex(cols);
  let justCommitted = false;
  let justDelivered = false;
  if (!row.committedAt && commitIdx >= 0 && destIdx >= commitIdx) {
    set.committedAt = now;
    justCommitted = true;
  }
  if (!row.startedAt && commitIdx >= 0 && destIdx > commitIdx) set.startedAt = now;
  if (!row.deliveredAt && dest.delivery) {
    set.deliveredAt = now;
    justDelivered = true;
  }

  // GUARDED ON THE COLUMN THAT WAS READ. The WIP check above counts a column and then writes without claiming
  // anything, so two people dragging into a column sitting one below its limit both counted `limit - 1`, both
  // passed, and both landed - the one thing the feature exists to prevent, on a surface several people work
  // at once by definition. The same window also let a move be decided against a column the card had already
  // left: the movement row below records `fromColumn: row.columnKey`, so a losing race wrote a transition
  // that never happened into `card_movements`, which is what `boardMetrics` builds the flow/CFD analytics
  // from. Zero rows here means somebody moved it first; the database decides who won, not the gap between two
  // statements. (Not `updateAtVersion`: a plain re-render bumps `updated_at`, while what this move depends on
  // is specifically where the card is.)
  const updated = (await deps.db.update(schema.cards).set(set).where(and(eq(schema.cards.uuid, id), eq(schema.cards.columnKey, row.columnKey))).returning())[0];
  if (!updated) throw aborted("the card moved while this move was being applied; re-read it and try again");
  if (changingColumn) {
    await deps.db.insert(schema.cardMovements).values({ cardId: id, boardId: row.boardId, fromColumn: row.columnKey, toColumn, actorId: actor.employeeId ?? null });
  }
  await audit(deps, actor, "card.move", "cards", id, changingColumn ? { from: row.columnKey, to: toColumn } : { reordered: true });
  if (changingAssignee) {
    await audit(deps, actor, "card.assign", "cards", id, { from: row.assigneeId ? `employees/${row.assigneeId}` : null, to: updated.assigneeId ? `employees/${updated.assigneeId}` : null });
    await notifyCardAssigned(deps, actor, updated, row.assigneeId);
  }

  // Watchers hear about a column change - which is what "how is that going" means on a board - and about
  // nothing else a move does. A reorder inside a column is housekeeping, and telling people about it is how a
  // watch button turns into a mute button.
  if (changingColumn) {
    const label = cols[destIdx]!.label;
    await notifyCardWatchers(deps, actor, updated, {
      type: "board.card_moved",
      title: `Moved to ${label}`,
      body: `${updated.title} → ${label}`,
    }, [updated.assigneeId]);
  }
  if (changingColumn) await emitEvent(deps, actor, "card.moved", { subject: `cards/${id}`, employeeId: updated.employeeId, payload: { board: `boards/${row.boardId}`, from: row.columnKey, to: toColumn } });
  if (justCommitted) await emitEvent(deps, actor, "card.committed", { subject: `cards/${id}`, employeeId: updated.employeeId, payload: { board: `boards/${row.boardId}`, column: toColumn } });
  if (justDelivered) await emitEvent(deps, actor, "card.delivered", { subject: `cards/${id}`, employeeId: updated.employeeId, payload: { board: `boards/${row.boardId}`, column: toColumn, goal: updated.goalId ? `goals/${updated.goalId}` : null } });
  await recomputeGoalProgress(deps, actor, updated.goalId); // delivery (or any move) shifts the linked goal's roll-up
  if (changingGoal && row.goalId) await recomputeGoalProgress(deps, actor, row.goalId); // the goal it left also re-rolls up
  return updated;
}

// Recompute a goal's progress from its linked tasks: share of delivered work, weighted by story points (`size`);
// when no linked task carries a size, fall back to a plain count. Reuses the `updateProgress` verb (audit +
// goal.progressUpdated/completed events). Best-effort. Only runs when the goal still has ≥1 linked task, so an
// unlinked/manual goal is never zeroed. This is the whole card→goal roll-up (no per-card % or per-board flag).
export async function recomputeGoalProgress(deps: Deps, actor: AppUser, goalId: string | null | undefined) {
  if (!goalId) return;
  try {
    const goal = (await deps.db.select({ del: schema.goals.deleteTime }).from(schema.goals).where(eq(schema.goals.uuid, goalId)).limit(1))[0];
    if (!goal || goal.del) return;
    const linked = await deps.db
      .select({ size: schema.cards.size, delivered: schema.cards.deliveredAt })
      .from(schema.cards)
      .where(and(eq(schema.cards.goalId, goalId), isNull(schema.cards.deleteTime)));
    if (!linked.length) return; // no linked tasks → leave the goal's (manual) progress untouched
    // Weight by story points where estimates exist; a card with no size still counts as 1 point (never 0) so
    // that delivering it always moves the goal - and the total matches the web "delivered/total tasks" count.
    const anySized = linked.some((c) => (c.size ?? 0) > 0);
    const weight = (c: { size: number | null }) => (anySized ? c.size ?? 1 : 1);
    const total = linked.reduce((s, c) => s + weight(c), 0);
    const done = linked.reduce((s, c) => s + (c.delivered ? weight(c) : 0), 0);
    const progress = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    const status = progress >= 100 ? "completed" : progress > 0 ? "in_progress" : undefined;
    await updateGoalProgress(deps, actor, goalId, progress, status);
  } catch {
    // best-effort: the triggering card change already committed; a roll-up failure must not undo it.
  }
}

export async function setCardBlocked(deps: Deps, actor: AppUser, id: string, blocked: boolean, reason?: string | null, blockedBy?: string | null) {
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  const blockerId = blocked ? idFromPath(blockedBy) ?? null : null;
  if (blockerId === id) throw invalidArgument("a task can't be blocked by itself");
  const updated = (await deps.db
    .update(schema.cards)
    .set({ blocked, blockReason: blocked ? reason?.trim() || null : null, blockedById: blockerId, updatedAt: new Date() })
    .where(eq(schema.cards.uuid, id))
    .returning())[0]!;
  await audit(deps, actor, blocked ? "card.block" : "card.unblock", "cards", id, blocked ? { reason: updated.blockReason, blockedBy: blockerId ? `cards/${blockerId}` : null } : undefined);
  if (blocked) await emitEvent(deps, actor, "card.blocked", { subject: `cards/${id}`, employeeId: updated.employeeId, payload: { board: `boards/${row.boardId}`, reason: updated.blockReason, blockedBy: blockerId ? `cards/${blockerId}` : null } });
  // Alert the assignee their task is now blocked (they own unblocking it).
  if (blocked && updated.assigneeId && updated.assigneeId !== actor.employeeId)
    await notify(deps, { recipient: updated.assigneeId, type: "board.card_blocked", title: "Your task was blocked", body: `${updated.keyPrefix && updated.seq ? `${updated.keyPrefix}-${updated.seq}: ` : ""}${updated.title}${updated.blockReason ? ` - ${updated.blockReason}` : ""}`, link: "boards", subject: `cards/${id}`, priority: "high", actorId: actor.employeeId });
  // Both directions reach the watchers. A card coming UNBLOCKED is the half nobody was ever told about, and
  // it is the one that means somebody's own work can start.
  await notifyCardWatchers(deps, actor, updated, blocked
    ? { type: "board.card_blocked", title: "A task you watch is blocked", body: `${updated.title}${updated.blockReason ? ` - ${updated.blockReason}` : ""}` }
    : { type: "board.card_unblocked", title: "A task you watch is unblocked", body: updated.title },
    [updated.assigneeId],
  );
  return updated;
}

export async function assignCard(deps: Deps, actor: AppUser, id: string, assignee?: string | null) {
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  const updated = (await deps.db.update(schema.cards).set({ assigneeId: idFromPath(assignee) ?? null, updatedAt: new Date() }).where(eq(schema.cards.uuid, id)).returning())[0]!;
  await audit(deps, actor, "card.assign", "cards", id, { from: row.assigneeId ? `employees/${row.assigneeId}` : null, to: updated.assigneeId ? `employees/${updated.assigneeId}` : null });
  await notifyCardAssigned(deps, actor, updated, row.assigneeId);
  return updated;
}

export async function prioritizeCard(deps: Deps, actor: AppUser, id: string, priority: CardPriority) {
  if (!CARD_PRIORITIES.includes(priority)) throw invalidArgument("priority is invalid");
  const row = await getCard(deps, actor, id);
  if (row.deleteTime) throw notFound("card not found");
  const updated = (await deps.db.update(schema.cards).set({ priority, updatedAt: new Date() }).where(eq(schema.cards.uuid, id)).returning())[0]!;
  await audit(deps, actor, "card.prioritize", "cards", id, { from: row.priority, to: priority });
  return updated;
}

export async function deleteCard(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const goalId = (await getCard(deps, actor, id)).goalId;
  await softDeleteRow(deps, actor, schema.cards, "card", "cards", id, ifMatch);
  await recomputeGoalProgress(deps, actor, goalId); // removing a linked task shifts the goal's roll-up
}
export async function restoreCard(deps: Deps, actor: AppUser, id: string) {
  const restored = await restoreRow(deps, actor, schema.cards, "card", "cards", id);
  await recomputeGoalProgress(deps, actor, (restored as { goalId?: string | null } | undefined)?.goalId);
  return restored;
}
// The card's own conversation and history go with it; the two pointers from records with a life of their own
// are cut. DECLARED rather than swept by hand first, so the whole teardown is one transaction: as six awaited
// statements ahead of the purge, a purge refused at the last step (a lost If-Match race) had already deleted
// every comment, to-do, movement and watcher of a card that is still there.
export const CARD_PURGE_CASCADE: PurgeCascade = {
  remove: [
    { table: schema.cardComments, column: schema.cardComments.cardId },
    { table: schema.cardTodos, column: schema.cardTodos.cardId },
    { table: schema.cardMovements, column: schema.cardMovements.cardId },
    { table: schema.cardWatchers, column: schema.cardWatchers.cardId },
  ],
  detach: [
    { table: schema.cards, column: schema.cards.blockedById }, // a card blocked by this one
    // A booked hour outlives the task it was booked against: the timesheet is approved, and in a payroll or a
    // client invoice it is a fact. So the link is cut, not the entry.
    { table: schema.timeEntries, column: schema.timeEntries.cardId },
  ],
};

export async function purgeCard(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  const goalId = (await getCard(deps, actor, id)).goalId;
  await purgeRow(deps, actor, schema.cards, "card", "cards", id, ifMatch, undefined, CARD_PURGE_CASCADE);
  await recomputeGoalProgress(deps, actor, goalId);
}
