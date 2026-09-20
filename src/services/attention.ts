// Assemble "what needs me" from signals the app already computes.
//
// The shape of every query here is the same: read a bounded window of rows the caller may already list, run a
// predicate that exists in the domain, and keep the ones it flags. Nothing is written, nothing is stored, and
// no number is worked out twice - `goalPace` and `staleDays` are the same functions the goal serializer calls,
// so this list and the Goals page can never disagree about which goals are in trouble.
//
// SCOPED BY THE ORDINARY DECISION. Each collection arrives with the ListScope its own list request would have
// been given (middleware/authz.ts, `attentionScopes`), and `applyScope` binds it - so a manager sees their
// team's goals here exactly because they could see them on the Goals page, and somebody who can list neither
// gets an empty list rather than an error. A collection missing from the map contributes nothing: fail closed
// is already `applyScope`'s behaviour for an absent scope.
//
// BOUNDED ON PURPOSE. Each source reads at most WINDOW rows before filtering. This runs on a dashboard load,
// on every visit, for everybody - a surface that scans the whole goals table to tell somebody about three of
// them is a surface that gets switched off. The window is ordered so the rows most likely to be flagged are
// the ones read.
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import * as schema from "../db/schema";
import { applyScope } from "./listScope";
import { goalPace, staleDays } from "../domain/goals";
import { fence } from "../domain/aiPolicy";
import { aiFeatureOn, aiGenerate } from "./ai";
import { notify } from "./notifications";
import { orgToday } from "./orgDay";
import { getSettingValue } from "./settings";
import { attentionConfigOf, rankAttention, type AttentionConfig, type AttentionItem } from "../domain/attention";

/** Rows read per source before filtering. See the header. */
const WINDOW = 200;

const DAY = 86_400_000;

/**
 * The org's thresholds, clamped.
 *
 * READ ONCE PER CALL and threaded down, rather than fetched inside each helper. `getSettingValue` is memoized
 * per request so a second read would be free, but passing it makes the dependency visible: a helper that
 * decides what "stale" means should say so in its signature rather than reach for it.
 */
async function config(deps: Deps): Promise<AttentionConfig> {
  return attentionConfigOf(await getSettingValue<Partial<AttentionConfig>>(deps, "attention", {}));
}

export type Attention = { items: AttentionItem[]; summary?: string };

export async function attentionFor(
  deps: Deps,
  user: AppUser,
  scopes: ReadonlyMap<string, ListScope>,
): Promise<Attention> {
  const now = deps.clock.now().getTime();
  const cfg = await config(deps);
  const found: AttentionItem[] = [
    ...await goalItems(deps, scopes.get("goals"), now, cfg),
    ...await cardItems(deps, scopes.get("cards"), now, cfg),
    ...await reviewItems(deps, user, scopes.get("reviews")),
  ];
  const items = rankAttention(found).slice(0, cfg.limit);
  const summary = await summarise(deps, user, items);
  return { items, ...(summary ? { summary } : {}) };
}

/**
 * One line saying what to look at first. Absent unless a model answers.
 *
 * THE LIST IS THE FEATURE; THIS IS AN ADDITION TO IT. Everything above is arithmetic and always runs, so a
 * refusal here - switched off, no binding, out of budget, a model error - costs a sentence and nothing else.
 * That ordering is deliberate: the moment the list itself depended on a model, a feature people rely on
 * daily would inherit an optional dependency's failure modes.
 *
 * WHAT THE MODEL IS SHOWN, and this is the careful part. Goal and card titles go in: neither collection is on
 * the denylist, and the titles are the caller's own work, already on their screen. REVIEWS DO NOT. `reviews`
 * is denylisted, and while a cycle name ("H1") is not an assessment, the honest way to keep it that way is to
 * not send review rows at all - so reviews reach the prompt as a COUNT and nothing else. A summary that said
 * "two reviews are waiting" is worth exactly as much as one naming them, and costs nothing to defend.
 *
 * No `collection` is declared on the call for the same reason it is omitted in `draftText`: `ctx.collection`
 * means "content from this collection is in the prompt", and `assertMayReachModel` answers it absolutely. The
 * two collections whose content IS here are both permitted; declaring one of the three would be picking a
 * favourite, and declaring `reviews` would be declaring something untrue.
 */
async function summarise(deps: Deps, user: AppUser, items: AttentionItem[]): Promise<string | undefined> {
  // Nothing to say about one thing: the row already says it, in more detail than a sentence would.
  if (items.length < 2) return undefined;
  if (!(await aiFeatureOn(deps, "attention.summary"))) return undefined;

  const reviews = items.filter((i) => i.kind === "review_waiting").length;
  const lines = items
    .filter((i) => i.kind !== "review_waiting")
    .map((i) => `- ${i.title}: ${i.detail}`);
  if (reviews > 0) lines.push(`- ${reviews} review${reviews === 1 ? "" : "s"} waiting on you`);

  const out = await aiGenerate(
    deps,
    { feature: "attention.summary", userId: user.uuid },
    {
      system:
        "You are given a list of things that are off track or waiting for one person at work. " +
        "Reply with ONE sentence, under 30 words, saying what they should look at first and why. " +
        "Name at most one item. Use only what the list says: invent no cause, no deadline and no blame, " +
        "and do not suggest what to do about it. No greeting, no preamble, no markdown.",
      user: fence("what is off track", lines.join("\n")),
      promptVersion: "v1",
      maxTokens: 80,
    },
  );
  if (!out.ok) return undefined;
  const text = out.value.trim().split("\n")[0]?.trim();
  return text && text.length > 0 ? text.slice(0, 300) : undefined;
}

/**
 * The Monday roundup: one notification per person who has something off track.
 *
 * NO MODEL, AND THAT IS ARITHMETIC RATHER THAN CAUTION. The dashboard's one-line summary costs a generation,
 * which `ESTIMATED_NEURONS` puts at about 120. A hundred people is 12,000 against a daily ceiling of 7,000 -
 * so a per-person written digest cannot fit in the free allocation at any company worth sending one to, and
 * the version that fits is the one that does not ask. The wording here is assembled from the same details the
 * list already carries.
 *
 * ONE QUERY PER SOURCE, NOT PER PERSON. `attentionFor` runs three queries for one caller, which is right on a
 * dashboard load and wrong on a cron: at a hundred people it would be three hundred, on a tick that already
 * runs twenty-two subtasks inside one invocation's subrequest budget. These read everyone's rows once and
 * group them in memory.
 *
 * NO SCOPE IS BOUND, and it would be wrong to bind one. There is no caller: each person is sent THEIR OWN
 * rows, selected by owner, so the only access question is "is this yours", which the grouping answers by
 * construction. A manager's digest is their own work, not their team's - the dashboard is where breadth
 * belongs, because there somebody is asking.
 */
export async function weeklyAttentionDigest(deps: Deps): Promise<number> {
  const cfg = await config(deps);
  if (!cfg.digestEnabled) return 0;
  const today = await orgToday(deps);
  // The chosen day IN THE ORG'S TIMEZONE, not the Worker's. A cron at 02:00 UTC is already Monday in Auckland
  // and still Sunday in Los Angeles; reading the day in UTC would send some people their week on the wrong one.
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== cfg.digestWeekday) return 0;

  const now = deps.clock.now().getTime();
  const byPerson = new Map<string, AttentionItem[]>();
  const add = (employeeId: string | null, item: AttentionItem) => {
    if (!employeeId) return;
    const list = byPerson.get(employeeId) ?? [];
    list.push(item);
    byPerson.set(employeeId, list);
  };

  for (const g of await deps.db
    .select({
      uuid: schema.goals.uuid, title: schema.goals.title, status: schema.goals.status, employeeId: schema.goals.employeeId,
      progress: schema.goals.progress, dueDate: schema.goals.dueDate, createdAt: schema.goals.createdAt, updatedAt: schema.goals.updatedAt,
    })
    .from(schema.goals)
    .where(and(isNull(schema.goals.deleteTime), inArray(schema.goals.status, ["not_started", "in_progress"])))
    .limit(DIGEST_WINDOW)) {
    for (const item of goalTrouble(g, now, cfg)) add(g.employeeId, item);
  }

  for (const c of await deps.db
    .select({ uuid: schema.cards.uuid, title: schema.cards.title, columnKey: schema.cards.columnKey, columnSince: schema.cards.columnSince, employeeId: schema.cards.employeeId })
    .from(schema.cards)
    .where(and(isNull(schema.cards.deleteTime), lt(schema.cards.columnSince, new Date(now - cfg.cardAgedDays * DAY))))
    .limit(DIGEST_WINDOW)) {
    add(c.employeeId, cardItem(c, now, cfg));
  }

  for (const r of await deps.db
    .select({
      uuid: schema.reviews.uuid, state: schema.reviews.state, employeeId: schema.reviews.employeeId,
      reviewerId: schema.reviews.reviewerId, revieweeManagerId: schema.employees.managerId, cycleName: schema.reviewCycles.name,
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewCycles, eq(schema.reviewCycles.uuid, schema.reviews.cycleId))
    .leftJoin(schema.employees, eq(schema.employees.uuid, schema.reviews.employeeId))
    .where(inArray(schema.reviews.state, ["SELF", "MANAGER", "SHARED"]))
    .limit(DIGEST_WINDOW)) {
    // The same three cases as the dashboard, and the same reviewer fallback - but here the OWNER of the item
    // is whoever it waits on, because that is who receives it.
    const writer = r.reviewerId ?? r.revieweeManagerId;
    if (r.state === "MANAGER") add(writer, reviewItem(r, "your review of this person is due"));
    else if (r.state === "SELF") add(r.employeeId, reviewItem(r, "your self-assessment is due"));
    else add(r.employeeId, reviewItem(r, "shared with you, waiting on your acknowledgement"));
  }

  let sent = 0;
  for (const [employeeId, found] of byPerson) {
    const items = rankAttention(found).slice(0, cfg.limit);
    if (items.length === 0) continue;
    // Best-effort per person: one recipient whose prefs or row is odd must not cost everybody else theirs.
    try {
      await notify(deps, {
        recipient: employeeId,
        type: "attention.weekly",
        title: `${items.length} thing${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} you this week`,
        // The top few, with their specifics. The rest are a count rather than a wall of text: this is a
        // nudge to open the dashboard, and a notification that reproduces the whole list replaces it badly.
        body: [
          ...items.slice(0, 3).map((i) => `${i.title} - ${i.detail}`),
          ...(items.length > 3 ? [`and ${items.length - 3} more`] : []),
        ].join("\n"),
        link: "/dashboard",
      });
      sent++;
    } catch (e) {
      console.error(`attention digest failed for employees/${employeeId}`, e);
    }
  }
  return sent;
}

/** Rows read per source for the whole org's digest. See the header: this is the ceiling on one cron tick's
 *  reads, not a page size, and a company past it gets a partial digest rather than a failed one. */
const DIGEST_WINDOW = 2000;

/**
 * Goals that will not land, and goals nobody has mentioned in three weeks.
 *
 * Both predicates live in domain/goals.ts and both decline to answer where there is no honest answer - a goal
 * with no due date cannot be behind, a finished goal is supposed to go quiet. That is why the filtering is in
 * JS rather than SQL: the rules about when the question has no answer are worth having in one place, and
 * re-expressing them as a WHERE clause is how the two drift apart.
 */
async function goalItems(deps: Deps, scope: ListScope | undefined, now: number, cfg: AttentionConfig): Promise<AttentionItem[]> {
  const rows = await deps.db
    .select({
      uuid: schema.goals.uuid, title: schema.goals.title, status: schema.goals.status,
      progress: schema.goals.progress, dueDate: schema.goals.dueDate,
      createdAt: schema.goals.createdAt, updatedAt: schema.goals.updatedAt,
    })
    .from(schema.goals)
    .where(and(
      applyScope(scope, schema.goals.code, schema.goals.employeeId),
      isNull(schema.goals.deleteTime),
      // Only goals still in play can need anything. Done is done, and both domain predicates decline to
      // answer for a finished goal anyway - this keeps the window from being spent on rows they would drop.
      inArray(schema.goals.status, ["not_started", "in_progress"]),
    ))
    // Soonest due first: a goal without a due date can only be stale, and staleness is the lower-ranked
    // signal, so the rows most likely to produce a high-ranked item are the ones this window keeps.
    .orderBy(schema.goals.dueDate)
    .limit(WINDOW);

  return rows.flatMap((g) => goalTrouble(g, now, cfg));
}

/**
 * What, if anything, is wrong with one goal. Shared by the dashboard and the weekly digest.
 *
 * ONE IMPLEMENTATION, for the reason the module header gives: two surfaces that each decide what "in trouble"
 * means will eventually disagree, and a person who sees a goal flagged on Monday and fine on Tuesday stops
 * believing either. The digest reads different rows in a different query; it must not also read them
 * differently.
 *
 * Returns at most one item. A goal that is both behind AND silent is one problem with two symptoms, and
 * listing it twice would push something else off a list of eight.
 */
type GoalRow = { uuid: string; title: string; status: string; progress: number | null; dueDate: Date | null; createdAt: Date; updatedAt: Date };
function goalTrouble(g: GoalRow, now: number, cfg: AttentionConfig): AttentionItem[] {
  const path = `goals/${g.uuid}`;
  const pace = goalPace({ createdAt: g.createdAt, dueDate: g.dueDate, progress: g.progress ?? 0, status: g.status }, now);
  if (pace && (pace.state === "at_risk" || pace.state === "behind")) {
    const left = g.dueDate ? Math.max(0, Math.ceil((+new Date(g.dueDate) + DAY - now) / DAY)) : 0;
    return [{
      kind: pace.state === "at_risk" ? "goal_at_risk" : "goal_behind",
      path,
      title: g.title,
      detail: `${Math.round(g.progress ?? 0)}% done, ${pace.expected}% expected by now, ${left} day${left === 1 ? "" : "s"} left`,
      days: -pace.drift, // further behind sorts first within the kind
    }];
  }
  const silent = staleDays({ updatedAt: g.updatedAt, status: g.status }, null, now);
  if (silent !== null && silent >= cfg.goalStaleDays) {
    return [{ kind: "goal_stale", path, title: g.title, detail: `no progress recorded in ${silent} days`, days: silent }];
  }
  return [];
}

/** One aged card as an item. Shared, for the same reason `goalTrouble` is. */
type CardRow = { uuid: string; title: string; columnKey: string; columnSince: Date | null };
function cardItem(c: CardRow, now: number, cfg: AttentionConfig): AttentionItem {
  const days = c.columnSince ? Math.floor((now - +new Date(c.columnSince)) / DAY) : cfg.cardAgedDays;
  return { kind: "card_aged", path: `cards/${c.uuid}`, title: c.title, detail: `in ${c.columnKey} for ${days} days`, days };
}

/** One waiting review as an item. The WORDING is the caller's, because who it waits on decides what it says. */
function reviewItem(r: { uuid: string; cycleName: string | null }, detail: string): AttentionItem {
  return { kind: "review_waiting", path: `reviews/${r.uuid}`, title: r.cycleName ?? "Review", detail };
}

/** Cards that have sat in one column long enough that the board is no longer telling the truth about them. */
async function cardItems(deps: Deps, scope: ListScope | undefined, now: number, cfg: AttentionConfig): Promise<AttentionItem[]> {
  const cutoff = new Date(now - cfg.cardAgedDays * DAY);
  const rows = await deps.db
    .select({
      uuid: schema.cards.uuid, title: schema.cards.title,
      columnKey: schema.cards.columnKey, columnSince: schema.cards.columnSince,
    })
    .from(schema.cards)
    .where(and(
      applyScope(scope, schema.cards.code, schema.cards.employeeId),
      isNull(schema.cards.deleteTime),
      // Filtered in SQL, unlike the goals above, because there is no domain predicate to respect here - the
      // question is just "has this column held it since before the cutoff", and asking the database is
      // cheaper than reading a window of cards that are fine.
      lt(schema.cards.columnSince, cutoff),
    ))
    .orderBy(schema.cards.columnSince)
    .limit(WINDOW);

  return rows.map((c) => cardItem(c, now, cfg));
}

/**
 * Reviews at a stage that is waiting on THIS person.
 *
 * The three cases are the ones the reviews page already draws a "needs you" pill for, decided here from the
 * row rather than from the browser: the reviewee owes their self-assessment, the reviewee's manager owes
 * theirs, and the reviewee owes an acknowledgement of what was shared. A review waiting on somebody else is
 * not this person's problem and is deliberately absent.
 */
async function reviewItems(deps: Deps, user: AppUser, scope: ListScope | undefined): Promise<AttentionItem[]> {
  const me = user.employeeId;
  if (!me) return [];
  const rows = await deps.db
    .select({
      uuid: schema.reviews.uuid, state: schema.reviews.state,
      employeeId: schema.reviews.employeeId, reviewerId: schema.reviews.reviewerId,
      revieweeManagerId: schema.employees.managerId,
      cycleName: schema.reviewCycles.name,
    })
    .from(schema.reviews)
    .leftJoin(schema.reviewCycles, eq(schema.reviewCycles.uuid, schema.reviews.cycleId))
    // For the writer, which is NOT always `reviewer_id`: that column is the override for "somebody other than
    // the current manager writes this one", and null means the manager chain, as the schema says. Resolving
    // it needs the reviewee's own manager, so the join is the question being asked rather than decoration.
    .leftJoin(schema.employees, eq(schema.employees.uuid, schema.reviews.employeeId))
    .where(and(
      applyScope(scope, schema.reviews.code, schema.reviews.employeeId),
      // No soft delete on `reviews` - checked rather than assumed, unlike goals and cards, which have one.
      inArray(schema.reviews.state, ["SELF", "MANAGER", "SHARED"]),
      // Mine to write, or mine to answer. Bound here so the window is not spent on reviews that belong to
      // other people's inboxes.
      or(
        eq(schema.reviews.employeeId, me),
        eq(schema.reviews.reviewerId, me),
        and(isNull(schema.reviews.reviewerId), eq(schema.employees.managerId, me)),
      ),
    ))
    .orderBy(desc(schema.reviews.updatedAt))
    .limit(WINDOW);

  const out: AttentionItem[] = [];
  for (const r of rows) {
    // The named reviewer if there is one, otherwise the reviewee's manager. Same fallback the write path uses.
    const writer = r.reviewerId ?? r.revieweeManagerId;
    const waiting =
      (r.state === "SELF" && r.employeeId === me) ? "your self-assessment is due"
        : (r.state === "MANAGER" && writer === me) ? "your review of this person is due"
          : (r.state === "SHARED" && r.employeeId === me) ? "shared with you, waiting on your acknowledgement"
            : null;
    if (!waiting) continue;
    out.push(reviewItem(r, waiting));
  }
  return out;
}
