// The DDL behind `GET /v1/changes`: a stamp per wire collection, bumped by a trigger on every write to the
// table that backs it. Generated from the authz collection->table registry so it can never miss a collection
// the app knows about; appended to the single Drizzle migration by `npm run db:generate` (drizzle-kit cannot
// emit triggers), and pinned by test/changeDdlDrift.test.ts.
//
// WHY TRIGGERS. The client's stored copies are only worth keeping if "nothing changed" is TRUSTWORTHY: a
// missed write means a page serves yesterday's rows and never finds out. Services cannot carry that guarantee -
// the accrual cron, the automation engine, the code cascade and the notification writer all write rows without
// an audit entry, and the next such writer would be added without anyone thinking about this file. A trigger
// sees every write, from any service, any cron, any seed, any manual SQL.
//
// WHY IT IS CHEAP. One row per collection (about seventy), so the stamp table stays tiny however big the data
// gets, and a write pays one upsert into it - next to the three statements the search index already costs.
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { TABLES } from "../lib/authzResolve";
import * as schema from "./schema";

const BREAK = "--> statement-breakpoint";

// Milliseconds since the epoch, as SQLite. Deliberately NOT `unixepoch('subsec')` (too new for some builds) and
// deliberately free of `CASE` - wrangler's migration splitter treats a bare CASE as opening a compound
// statement and swallows every following `;` until it sees `END` followed by whitespace, which an expression's
// `END` never is (see the same note in searchDdl.ts).
const NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

const stamp = (collection: string) =>
  `INSERT INTO "collection_versions" ("collection", "at") VALUES ('${collection}', ${NOW_MS}) ` +
  `ON CONFLICT("collection") DO UPDATE SET "at" = ${NOW_MS}`;

const HEADER = `-- Collection change stamps. GENERATED from the authz collection->table registry by scripts/genChangeDdl.ts
-- - do not edit by hand; run \`npm run db:generate\`. One row per collection, bumped by the triggers below, so
-- \`GET /v1/changes\` can tell a client exactly which of its stored copies are still good.`;

function triggersFor(collection: string, table: unknown, slugOverride?: string): string[] {
  const name = getTableConfig(table as never).name;
  const slug = stampSlug(slugOverride ?? collection);
  // One trigger per write kind rather than one with a compound condition: an AFTER trigger fires per ROW, and
  // a bulk write therefore bumps the same stamp repeatedly - harmless (the upsert is idempotent) and far
  // simpler than trying to be clever about it.
  return (["INSERT", "UPDATE", "DELETE"] as const).map(
    (kind) =>
      `CREATE TRIGGER "chg_${kind.slice(0, 1).toLowerCase()}_${slug}" AFTER ${kind} ON "${name}" BEGIN
  ${stamp(collection)};
END`,
  );
}

// Tables the client caches from that the collection->table registry does not name, so nothing would have
// stamped them:
//   - `settings` backs the org config snapshot the SPA holds (lib/settingsStore.ts) and, through it, the
//     "collections" that are really settings keys (bank-formats, ticket-categories, the asset-tag policy...).
//     Without a stamp the snapshot could not be told it was out of date at all: only a write from the same
//     browser dropped it, so an org whose config another admin had edited went on reading the old one for as
//     long as that copy lived.
//   - `roles`, `access-rules` and `policy` are read by the access-management UI like any other collection, and
//     `roles` is cached as a catalog. They do NOT carry the caller's own permission changes: that is the
//     `authz_version` in services/changes.ts, computed from the compiled grant, which needs no stamp.
//
// Keyed by the COLLECTION PATH, not the table name, because the key becomes the stamped value - and
// `GET /v1/changes` filters its answer to the collections the caller may list, which are named in kebab. A
// stamp written as `access_rules` matches nothing there and could never be reported, which is the whole point
// of having one. The trigger name takes the same `-` -> `_` rewrite every other collection's does.
const EXTRA_TABLES: Record<string, unknown> = {
  settings: schema.settings,
  roles: schema.roles,
  "access-rules": schema.accessRules,
  policy: schema.policy,
};

/** The collections stamped beyond the registry. Exported for the drift test. */
export const EXTRA_STAMPS = Object.keys(EXTRA_TABLES);

/** A collection's trigger-name slug. The one place that rewrite is spelled, so the drift test cannot drift. */
export const stampSlug = (collection: string) => collection.replace(/-/g, "_");

// Tables that are nobody's collection but whose rows CHANGE one. An RSVP is a row in `event_responses` and it
// moves the going count ON THE EVENT; a reaction, a read receipt or a reply moves an announcement's counts; a
// comment or a checklist tick moves a ticket's. The parent's rows are what a client stores, so a write here
// has to stamp the PARENT - otherwise `GET /v1/changes` says nothing changed and a stored copy keeps
// yesterday's numbers for as long as it lives (an RSVP that never appears, a reaction count stuck at zero).
//
// Keyed by table name so several can stamp the same collection, which is the usual shape here.
const SIDE_TABLES: Record<string, { table: unknown; collection: string }> = {
  // A split is a field of the expense that carries it (`allocations` on the serialized row), so editing one is
  // a change to that expense exactly as editing its amount is. Without the stamp, re-splitting an invoice would
  // leave every client's cached ledger showing the old division until something else touched the row.
  expense_allocations: { table: schema.expenseAllocations, collection: "expenses" },
  event_responses: { table: schema.eventResponses, collection: "events" },
  announcement_reads: { table: schema.announcementReads, collection: "announcements" },
  announcement_reactions: { table: schema.announcementReactions, collection: "announcements" },
  announcement_replies: { table: schema.announcementReplies, collection: "announcements" },
  announcement_poll_options: { table: schema.announcementPollOptions, collection: "announcements" },
  announcement_poll_votes: { table: schema.announcementPollVotes, collection: "announcements" },
  // A user's SECONDARY roles are a field of the account (`roles` on the serialized user), so a write here is a
  // change to that collection exactly as a write to `users.role` is. Without the stamp, granting somebody a
  // second role would leave every client's cached account list showing the old set until something else
  // happened to touch `users`.
  user_roles: { table: schema.userRoles, collection: "users" },
  card_comments: { table: schema.cardComments, collection: "cards" },
  card_todos: { table: schema.cardTodos, collection: "cards" },
  card_movements: { table: schema.cardMovements, collection: "cards" },
  // THE FOLLOW STATE AND THE CREDIT SPLIT, which are side tables of exactly the kind the paragraph above
  // describes and were the three the list did not name. Both resources carry them as fields of the PARENT:
  // a card ships `watchers`/`watcher_count`/`watching`, a goal ships those plus `contributors` (http/
  // serialize.ts, decorated per page by cards.ts#watchersFor and goals.ts#goalWatchersFor/contributorsFor).
  // `:watch` and `:setContributors` write ONLY here - neither touches the parent row - so nothing stamped the
  // collection and `GET /v1/changes` reported that goals and cards had not changed. A stored copy therefore
  // kept the old watch state and the old split for as long as it lived: press Watch, reload, and the button
  // is back where it started. The global list validator (http/listEtag.ts) is built from the same stamps, so
  // the list re-read was answered 304 as well.
  goal_watchers: { table: schema.goalWatchers, collection: "goals" },
  goal_contributors: { table: schema.goalContributors, collection: "goals" },
  card_watchers: { table: schema.cardWatchers, collection: "cards" },
  goal_comments: { table: schema.goalComments, collection: "goals" },
  ticket_comments: { table: schema.ticketComments, collection: "tickets" },
  ticket_todos: { table: schema.ticketTodos, collection: "tickets" },
  suggestion_votes: { table: schema.suggestionVotes, collection: "suggestions" },
  loan_repayments: { table: schema.loanRepayments, collection: "loans" },
  payroll_run_items: { table: schema.payrollRunItems, collection: "payroll-runs" },
  comp_off_credits: { table: schema.compOffCredits, collection: "leave-balances" },
};

/** The side tables and the collection each one stamps. Exported for the drift test. */
export const SIDE_STAMPS = Object.entries(SIDE_TABLES).map(([table, { collection }]) => [table, collection] as const);

/**
 * The tables that deliberately stamp NOTHING, and why each one is safe.
 *
 * This list is the other half of the guard. Every check above asks "does what we declared get a trigger?",
 * which is only ever wrong in the direction nobody notices: a table nobody REMEMBERED to declare passes all of
 * them, because it appears in none of the maps being checked. That is precisely how `goal_watchers`,
 * `goal_contributors` and `card_watchers` sat unstamped - each is a side table of a collection the client
 * caches, and nothing anywhere said so. Held against `db/schema.ts` itself (test/changeDdlDrift.test.ts), this
 * turns adding a table into a decision: stamp it, map it to its parent, or say here why it needs neither.
 *
 * The bar for membership is that NO WIRE RESOURCE CHANGES when the table is written. "It is internal" is not
 * enough on its own - `card_movements` is internal too, and it moves a card's cycle-time numbers.
 */
export const UNSTAMPED_TABLES: Record<string, string> = {
  // The stamp table itself; stamping it would make every write look like a change to everything.
  collection_versions: "the stamp table",
  // Read through `GET /v1/activity`, which pages on the audit row's own `at` and stores nothing client-side.
  audit_log: "paged by its own timestamp; never cached as a collection",
  // Allocation counters behind owned codes. Never read over the wire.
  code_sequences: "internal counter, not part of any resource",
  // Replay answers for re-sent writes (middleware/idempotency.ts). The write it replays stamps its own table.
  idempotency_keys: "internal replay store; the write it answers for is stamped",
  // The digest worker's queue. Its OUTPUT is a notification, and `notifications` is a stamped collection.
  notification_digest_queue: "internal queue; the notification it produces is stamped",
  // The app lock (services/appLock.ts): PIN hashes, wrong-PIN counts, revoked unlock proofs. Read only by the auth
  // middleware and /auth/lock, never cached by a client, and kept off `users` precisely so a lock or an unlock
  // stales nothing anybody holds.
  app_locks: "sign-in state read only by the auth middleware; never cached as a collection",
  // Loss-of-pay corrections waiting for a run to pay them. Not its own wire collection, and - the reason it
  // is here rather than a SIDE_TABLE - raising one makes nothing a client already holds stale. The closed
  // run it corrects is history and does not change; the correction only becomes visible when the NEXT run is
  // built, and that build stamps `payroll-runs` and `payslips` itself. Same shape as the digest queue: an
  // internal queue whose output is stamped.
  lop_adjustments: "internal payable queue; the run item it becomes is stamped when the next run is built",
  // The FTS index. Written by the search triggers whenever a stamped row is written, so it is stamped already -
  // one hop back - and `/v1/search` is a live query that caches nothing.
  search_docs: "derived from stamped tables; search results are never stored",
  // The semantic index's bookkeeping: which `search_docs` row was embedded, for which text and which model.
  // One hop further back than the FTS index and the same argument - a row here moves only when the row it
  // describes has already been written and stamped, and nothing over the wire carries its values.
  search_vectors: "index bookkeeping for stamped rows; search results are never stored",
  // Per-VIEWER UI state (theme, tab badges), fetched by its own key-addressed route and never listed. The
  // browser that wrote it is the only one that reads it back.
  preferences: "per-viewer UI state, key-addressed, never listed",
  // The per-pattern grant usage counter. Written on every audited allow, read only by the access review
  // (`POST /v1/access-rules:review`), which is a live report and caches nothing. Stamping it would mark the
  // access-rules collection changed on every audited request in the app - the opposite of what a change stamp
  // is for, and it would invalidate every client's rule cache continuously.
  rule_usage: "internal counter; the review that reads it is a live report, never cached as a collection",
  // The inference trail. Written on every model call, and no wire resource carries a row's own values: what a
  // reader sees is a spend report built live from it. Stamping it would mark a collection changed on every
  // inference the app performs, including the ones made for that reader's own request.
  ai_usage: "internal inference trail; the spend report that reads it is live, never cached as a collection",
  // Generation cache, keyed by a hash of the inputs. A hit changes nothing anybody reads: the output it holds
  // is what the same call would have produced, and the resource it lands on is stamped when it is written.
  ai_cache: "internal result cache; the record the output is written to is stamped on its own",
  // A machine's suggestion about a record, plus what a human did with it. Deliberately NOT a stamp on the
  // collection it concerns: a suggestion is not a change to the ticket, and treating it as one would tell
  // every client the ticket had been edited each time somebody opened the triage panel. It is read live
  // through `tickets:triage`, computed per call, and never held client-side as a collection. When a
  // suggestion IS accepted, the write that follows goes through `tickets:route` / `:prioritize`, and those
  // stamp `tickets` themselves - which is the change a reader actually cares about.
  ai_suggestions: "advisory record read live through its host's verb; accepting one writes through the host, which is stamped",
  // Bookkeeping for the moderation sweep: which post was scanned, from what text, by which model. Nobody
  // reads it - it exists so the drain can tell an unscanned post from one already found unremarkable. A scan
  // changes no collection, and stamping one would mark the noticeboard edited every five minutes for work
  // that produced nothing. When a scan DOES produce something it writes an `ai_suggestions` row, which is
  // unstamped for its own reasons above; and when a person acts on that, the write lands on `announcements`
  // or `suggestions` and stamps those.
  moderation_scans: "sweep bookkeeping for stamped rows; a scan changes nothing a reader sees",
};

// `attachments` is a side table too, but a POLYMORPHIC one: every row names its own parent collection, so
// which stamp a write moves is data, not a mapping. Hence its own triggers, reading the collection off the
// row - `NEW` for a write, `OLD` for a delete.
//
// It has to stamp SOMETHING. Attachment presence is a field on the parent as the wire shows it (a referral's
// `has_resume`, a reimbursement's receipt, an expense's invoice), and it is computed per request from this
// table - so attaching a file changes what a list of the parent says while touching no parent row. With no
// stamp, `GET /v1/changes` reported nothing and the global list validator (http/listEtag.ts) still matched:
// the client asked, was told 304, and went on showing "Attach" over a resume it had just uploaded.
const ATTACHMENT_TRIGGERS = (["INSERT", "UPDATE", "DELETE"] as const).map((kind) => {
  const row = kind === "DELETE" ? "OLD" : "NEW";
  return `CREATE TRIGGER "chg_${kind.slice(0, 1).toLowerCase()}_attachments" AFTER ${kind} ON "attachments" BEGIN
  INSERT INTO "collection_versions" ("collection", "at") VALUES (${row}."collection", ${NOW_MS}) ON CONFLICT("collection") DO UPDATE SET "at" = ${NOW_MS};
END`;
});

/** The full generated block, ready to append to the migration. Deterministic: same registry, same bytes. */
export function renderChangeDdl(): string {
  const statements: string[] = [];
  // Sorted, so the generated bytes do not depend on the registry's declaration order.
  const all: Record<string, unknown> = { ...TABLES, ...EXTRA_TABLES };
  for (const collection of Object.keys(all).sort()) statements.push(...triggersFor(collection, all[collection]));
  // Side tables last, named after the TABLE (several stamp the same collection, so the collection cannot name
  // the trigger), and sorted for the same reason the block above is.
  for (const table of Object.keys(SIDE_TABLES).sort()) {
    const side = SIDE_TABLES[table]!;
    statements.push(...triggersFor(side.collection, side.table, table));
  }
  statements.push(...ATTACHMENT_TRIGGERS);
  // The header rides ON the first statement rather than standing as one of its own: every runner splits this
  // file on the breakpoint and hands each piece to D1, which rejects a piece holding only a comment.
  statements[0] = `${HEADER}\n${statements[0]}`;
  return statements.join(`;\n${BREAK}\n`) + ";";
}

/** Marker the generator writes before the block, so re-running replaces it rather than appending twice. */
export const CHANGE_DDL_MARKER = "-- Collection change stamps. GENERATED from the authz collection->table registry";

// ---- The block across migrations ------------------------------------------------------------------------------
//
// The generated block lives in 0000, which production has applied and which is never rewritten (migrations are
// append-only). A table added later gets its stamp triggers from the migration that creates it, written there by
// hand, and a trigger whose body changes is replaced there with DROP TRIGGER + CREATE TRIGGER. So "does the
// database carry the triggers the registry describes" is a question about ALL the migrations applied in order,
// not about one block - these three functions answer it, for scripts/genChangeDdl.ts and the drift test alike.

const TRIGGER_STATEMENT = /DROP TRIGGER (?:IF EXISTS )?"(chg_[A-Za-z0-9_]+)"|CREATE TRIGGER "(chg_[A-Za-z0-9_]+)" AFTER (?:INSERT|UPDATE|DELETE) ON "[^"]+" BEGIN\n[\s\S]*?\nEND/g;

/** Every stamp trigger a piece of SQL creates, by name, as its CREATE statement (without the `;`). */
export function changeTriggersIn(sql: string): Map<string, string> {
  return applyTriggerStatements(new Map(), sql);
}

function applyTriggerStatements(into: Map<string, string>, sql: string): Map<string, string> {
  for (const m of sql.matchAll(TRIGGER_STATEMENT)) {
    if (m[1]) into.delete(m[1]);
    else into.set(m[2]!, m[0]);
  }
  return into;
}

/** The stamp triggers the migrations leave in place, applied in file order (DROP removes, CREATE sets). */
export function appliedChangeTriggers(migrationsInOrder: readonly string[]): Map<string, string> {
  const applied = new Map<string, string>();
  for (const sql of migrationsInOrder) applyTriggerStatements(applied, sql);
  return applied;
}

/**
 * What a new migration has to carry so the applied triggers match the generator: a CREATE for each missing one,
 * DROP + CREATE for each whose body changed, and a DROP for each the registry no longer describes. Empty when
 * they already match. Each entry is one statement, ready to join with a statement breakpoint.
 */
export function changeDdlDelta(applied: ReadonlyMap<string, string>): string[] {
  const wanted = changeTriggersIn(renderChangeDdl());
  const out: string[] = [];
  for (const [name, create] of wanted) {
    const have = applied.get(name);
    if (have === create) continue;
    if (have !== undefined) out.push(`DROP TRIGGER IF EXISTS "${name}";`);
    out.push(`${create};`);
  }
  for (const name of applied.keys()) if (!wanted.has(name)) out.push(`DROP TRIGGER IF EXISTS "${name}";`);
  return out;
}
