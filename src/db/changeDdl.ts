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
  event_responses: { table: schema.eventResponses, collection: "events" },
  announcement_reads: { table: schema.announcementReads, collection: "announcements" },
  announcement_reactions: { table: schema.announcementReactions, collection: "announcements" },
  announcement_replies: { table: schema.announcementReplies, collection: "announcements" },
  announcement_poll_options: { table: schema.announcementPollOptions, collection: "announcements" },
  announcement_poll_votes: { table: schema.announcementPollVotes, collection: "announcements" },
  card_comments: { table: schema.cardComments, collection: "cards" },
  card_todos: { table: schema.cardTodos, collection: "cards" },
  card_movements: { table: schema.cardMovements, collection: "cards" },
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
