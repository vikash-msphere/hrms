// The DDL that makes global search cheap: the FTS5 index behind `search_docs`, plus the triggers that keep
// both in sync with every source table. Generated from SEARCH_INDEX so it can never drift from what search
// claims to cover (drizzle-kit cannot emit virtual tables or triggers), and pinned by
// test/searchDdlDrift.test.ts.
//
// ACROSS MIGRATIONS, AS A DELTA. The full block lives in 0000, which production has applied, and migrations
// are append-only. So a registry change ships in a NEW migration carrying only what moved - the same model as
// the change stamps (src/db/changeDdl.ts): the triggers every migration leaves in place, applied in order, are
// compared with the generator's (`searchDdlDelta`), and a collection indexed for the first time also gets its
// backfill. The FTS table itself is not part of the delta: changing its columns is a rebuild of every trigger
// and every row, which is a decision for a person, and the drift gate fails until one is written.
//
// WHY. `LIKE '%q%'` cannot use an index, so the previous design scanned every searchable table on every
// query. D1 bills rows READ, so that cost scaled with the size of the database and would have exhausted the
// daily read budget after a few dozen searches. FTS5 turns the same query into an index lookup: a hit reads
// the matching rows, a miss reads none, and neither grows as the data does.
//
// WHY TRIGGERS. The index must be correct for every write - services, cron, automations, seeds and manual
// SQL alike. A trigger is the only place that sees all of them, so no service is touched and nothing can be
// forgotten. `search_fts.rowid` is kept equal to the `search_docs` rowid, so a match joins straight across.
//
// WHAT A WRITE COSTS. D1 bills rows WRITTEN, and an FTS5 row is not one row: it writes its content, its size,
// a new index segment, and every few inserts a merge that rewrites segments - with `prefix='2 3'` on top. So:
//   - A doc with no words (an attendance punch with no note) gets NO FTS row. Every doc has its `search_docs`
//     row, which is what `in:` and the filters list; only a typed word needs the FTS row, and no word reaches
//     an empty one anyway.
//   - The update trigger fires only when a column it reads changed (`WHEN`), and rewrites the FTS row only
//     when a matched column did. Clocking out, a status flip, a soft delete: none of them touches the
//     keyword text, so none of them pays for it.
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { SEARCH_INDEX, type SearchEntry } from "../domain/searchIndex";
import type { StateRule } from "../domain/manifests";

/** The state-visibility rules the generated triggers bake in, keyed by collection (the manifest's shape). */
export type StateVisibility = Readonly<Record<string, StateRule>>;

const BREAK = "--> statement-breakpoint";

// SQL name of a Drizzle column property, or undefined when the table has no such column.
const col = (table: any, prop: string): string | undefined => table[prop]?.name;

const qualify = (prefix: string, name: string) => `${prefix}"${name}"`;

// "first non-empty of", as SQL. coalesce() needs two or more arguments, hence the single-column case.
function firstNonEmpty(table: any, props: string[] | undefined, prefix: string): string {
  const cols = (props ?? []).map((p) => col(table, p)).filter(Boolean) as string[];
  if (cols.length === 0) return "NULL";
  const parts = cols.map((c) => `nullif(trim(${qualify(prefix, c)}), '')`);
  return parts.length === 1 ? parts[0]! : `coalesce(${parts.join(", ")})`;
}

// All the columns joined into one space-separated string - what FTS5 tokenizes for this record.
function joined(table: any, props: string[], prefix: string): string {
  const cols = props.map((p) => col(table, p)).filter(Boolean) as string[];
  if (cols.length === 0) return "''";
  return cols.map((c) => `coalesce(${qualify(prefix, c)}, '')`).join(" || ' ' || ");
}

function titleExpr(entry: SearchEntry, prefix: string): string {
  if (!entry.joinTitle) return firstNonEmpty(entry.table, entry.title, prefix);
  const cols = (entry.title ?? []).map((p) => col(entry.table, p)).filter(Boolean) as string[];
  return `nullif(trim(${cols.map((c) => `coalesce(${qualify(prefix, c)}, '')`).join(" || ' ' || ")}), '')`;
}

// Soft-deleted rows stay in the index (so a restore needs no reindex) and are filtered at query time.
//
// NOTE on the shape of these expressions: they are deliberately written as plain boolean predicates rather
// than `CASE WHEN ... END`. Wrangler's migration splitter treats a bare `CASE` as opening a compound statement
// and only closes it on `END` followed by `;` or whitespace (`/\sEND[;\s]$/`) - an `END,` inside an expression
// list never closes it, so every following `;` is swallowed and the rest of the migration is sent as one
// oversized statement (SQLITE_TOOBIG). SQLite yields 0/1 from a comparison anyway, so `CASE` buys nothing
// here. test/searchDdlDrift.test.ts replays the splitter's own rules to keep this from regressing.
// It also covers the moderation gate's `held_at`, and the column is really "withheld from results" rather
// than "deleted". The two stamps want identical treatment and for the same reason the comment above gives:
// the row stays in the index, is filtered out of every query, and comes back the moment the stamp clears -
// so releasing a held post needs no reindex, exactly as restoring a deleted one does not. Folding it in here
// is also what keeps a held post out of ⌘K without a second flag for every query to remember.
function deletedExpr(entry: SearchEntry, prefix: string): string {
  const stamps = ["deleteTime", "heldAt"]
    .map((prop) => col(entry.table, prop))
    .filter(Boolean)
    .map((c) => `${qualify(prefix, c!)} IS NOT NULL`);
  return stamps.length ? `(${stamps.join(" OR ")})` : "0";
}

// Mirrors the state-visibility manifest's `public_when` for this collection: 1 when the row is NOT public, so
// the query can hide it from callers without the editing level. Built from the rules the CALLER passes - the
// seeded manifest (bootstrap/authz/policy.ts), which scripts/genSearchDdl.ts hands in - because a trigger is
// DDL written at migration time. A collection whose state rule is edited at RUNTIME needs its index rebuilt,
// which is why state visibility is treated as structural here.
// A single-quoted SQL literal. The values come from the typed manifest in this repo, never from a request, so
// this is about generating valid DDL rather than about injection - but doubling the quote is what makes a state
// like `o'brien` produce a working index instead of a syntax error at migration time.
const sqlStr = (v: string) => `'${v.replace(/'/g, "''")}'`;

// A manifest field (`snake_case`) as the Drizzle property it names.
const propOf = (field: string) => field.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());

function restrictedExpr(entry: SearchEntry, prefix: string, sv: StateVisibility): string {
  const rule = sv[entry.collection];
  if (!rule) return "0";
  // "restricted" is the negation of "public", so each public_when clause is inverted and the set ORed. The
  // coalesce keeps a NULL column from making the whole expression NULL, which a NOT NULL column would reject.
  const clauses = Object.entries(rule.public_when)
    .map(([field, want]) => {
      const c = col(entry.table, propOf(field));
      if (!c) return null;
      const q = qualify(prefix, c);
      // A boolean clause keeps the original numeric form (SQLite stores them as 0/1). A STRING clause compares
      // as text, and a NULL status must read as restricted - `coalesce` to a value no status can equal, rather
      // than to 0, which a string comparison would never match anyway and which reads as a copy-paste slip.
      if (typeof want === "boolean") return `coalesce(${q}, 0) <> ${want ? 1 : 0}`;
      const wanted = (Array.isArray(want) ? want : [want]).map(sqlStr);
      return `coalesce(${q}, '') NOT IN (${wanted.join(", ")})`;
    })
    .filter(Boolean);
  return clauses.length === 0 ? "0" : `(${clauses.join(" OR ")})`;
}

// The owner column applyScope binds for this collection - NULL for a flat catalog, which binds no scope.
function ownerExpr(entry: SearchEntry, prefix: string): string {
  if (entry.scoping.kind === "flat") return "NULL";
  const c = col(entry.table, entry.scoping.owner);
  return c ? qualify(prefix, c) : "NULL";
}

const DOC_COLS = "collection, record_id, code, owner_id, title, subtitle, deleted, restricted, created_at";

// The source row's own creation stamp, copied into the doc so "how many arrived since I last looked" is one
// indexed count over search_docs rather than a page of every collection. Every searchable table has
// `createdAt` (pinned by test/searchDdlDrift.test.ts); NULL for any that ever stops having one, which reads as
// "never new" rather than as an error.
function createdExpr(entry: SearchEntry, prefix: string): string {
  const c = col(entry.table, "createdAt");
  return c ? qualify(prefix, c) : "NULL";
}

// "Did any of these properties' columns change", as `old."a" IS NOT new."a" OR ...`. IS NOT, so a NULL on one side
// compares as a value instead of making the whole test NULL (which a trigger's WHEN reads as false).
function changedExpr(table: any, props: string[]): string {
  const cols = [...new Set(props.map((p) => col(table, p)).filter(Boolean) as string[])];
  return cols.length === 0 ? "0" : cols.map((c) => `${qualify("old.", c)} IS NOT ${qualify("new.", c)}`).join(" OR ");
}

// Every property the doc and its FTS text are built from: an update that changes none of them leaves the index
// exactly as it was, so the update trigger does not fire for it.
function readProps(entry: SearchEntry, sv: StateVisibility): string[] {
  return [
    "code",
    ...(entry.scoping.kind === "flat" ? [] : [entry.scoping.owner]),
    ...(entry.title ?? []),
    ...(entry.subtitle ?? []),
    ...entry.match,
    "deleteTime",
    "heldAt",
    ...Object.keys(sv[entry.collection]?.public_when ?? {}).map(propOf),
  ];
}

// Writes `text` into the FTS row `rowidExpr` only when it has a word in it: a doc with no words has no FTS row.
const ftsInsert = (rowidExpr: string, text: string, also = "") =>
  `INSERT INTO "search_fts" ("rowid", "text") SELECT ${rowidExpr}, "text" FROM (SELECT ${text} AS "text") WHERE trim("text") <> ''${also}`;

function triggersFor(entry: SearchEntry, sv: StateVisibility): string[] {
  const table = getTableConfig(entry.table).name;
  const slug = entry.collection.replace(/-/g, "_");
  const idCol = col(entry.table, "uuid")!;
  const codeCol = col(entry.table, "code");
  const matchChanged = changedExpr(entry.table, entry.match);

  const values = (prefix: string) =>
    [
      `'${entry.collection}'`,
      qualify(prefix, idCol),
      codeCol ? qualify(prefix, codeCol) : "NULL",
      ownerExpr(entry, prefix),
      titleExpr(entry, prefix),
      firstNonEmpty(entry.table, entry.subtitle, prefix),
      deletedExpr(entry, prefix),
      restrictedExpr(entry, prefix, sv),
      createdExpr(entry, prefix),
    ].join(", ");

  const body = (prefix: string) => joined(entry.table, entry.match, prefix);
  const locate = (idRef: string) => `SELECT "rowid" FROM "search_docs" WHERE "collection" = '${entry.collection}' AND "record_id" = ${idRef}`;

  return [
    `CREATE TRIGGER "search_ai_${slug}" AFTER INSERT ON "${table}" BEGIN
  INSERT INTO "search_docs" (${DOC_COLS}) VALUES (${values("new.")});
  ${ftsInsert("last_insert_rowid()", body("new."))};
END`,
    // An update rewrites the doc in place. INSERT OR REPLACE is avoided so the rowid - and therefore the FTS
    // row it is joined to - survives the edit. The FTS row is replaced (FTS5 runs an UPDATE as exactly this
    // delete + insert) rather than updated, because it may not exist yet: a doc that gains its first words
    // gets one, and one that loses them has it removed.
    `CREATE TRIGGER "search_au_${slug}" AFTER UPDATE ON "${table}"
WHEN ${changedExpr(entry.table, readProps(entry, sv))} BEGIN
  UPDATE "search_docs" SET "code" = ${codeCol ? qualify("new.", codeCol) : "NULL"}, "owner_id" = ${ownerExpr(entry, "new.")}, "title" = ${titleExpr(entry, "new.")}, "subtitle" = ${firstNonEmpty(entry.table, entry.subtitle, "new.")}, "deleted" = ${deletedExpr(entry, "new.")}, "restricted" = ${restrictedExpr(entry, "new.", sv)} WHERE "collection" = '${entry.collection}' AND "record_id" = ${qualify("new.", idCol)};
  DELETE FROM "search_fts" WHERE "rowid" = (${locate(qualify("new.", idCol))}) AND (${matchChanged});
  ${ftsInsert(`(${locate(qualify("new.", idCol))})`, body("new."), ` AND (${matchChanged})`)};
END`,
    `CREATE TRIGGER "search_ad_${slug}" AFTER DELETE ON "${table}" BEGIN
  DELETE FROM "search_fts" WHERE "rowid" = (${locate(qualify("old.", idCol))});
  DELETE FROM "search_docs" WHERE "collection" = '${entry.collection}' AND "record_id" = ${qualify("old.", idCol)};
END`,
  ];
}

// Index whatever is already in the table. A no-op on a fresh database (the triggers cover everything written
// afterwards, seeds included); it matters when this DDL is applied to a database that already holds rows.
function backfillFor(entry: SearchEntry, sv: StateVisibility): string[] {
  const table = getTableConfig(entry.table).name;
  const idCol = col(entry.table, "uuid")!;
  const codeCol = col(entry.table, "code");
  const select = [
    `'${entry.collection}'`,
    qualify("t.", idCol),
    codeCol ? qualify("t.", codeCol) : "NULL",
    ownerExpr(entry, "t."),
    titleExpr(entry, "t."),
    firstNonEmpty(entry.table, entry.subtitle, "t."),
    deletedExpr(entry, "t."),
    restrictedExpr(entry, "t.", sv),
    createdExpr(entry, "t."),
  ].join(", ");
  return [
    `INSERT INTO "search_docs" (${DOC_COLS}) SELECT ${select} FROM "${table}" t`,
    `INSERT INTO "search_fts" ("rowid", "text") SELECT d."rowid", ${joined(entry.table, entry.match, "t.")} FROM "search_docs" d JOIN "${table}" t ON t."${idCol}" = d."record_id" WHERE d."collection" = '${entry.collection}' AND d."rowid" NOT IN (SELECT "rowid" FROM "search_fts") AND trim(${joined(entry.table, entry.match, "t.")}) <> ''`,
  ];
}

// `prefix='2 3'` makes 2- and 3-character prefix queries index-backed, which is what a search-as-you-type box
// issues; unicode61 folds capitalisation and diacritics.
export const FTS_TABLE_DDL = `CREATE VIRTUAL TABLE "search_fts" USING fts5("text", prefix='2 3', tokenize='unicode61')`;

/** The full generated block, as 0000 carries it. Deterministic: same registry, same bytes. */
export function renderSearchDdl(sv: StateVisibility): string {
  const statements: string[] = [
    `-- Global search index. GENERATED from src/domain/searchIndex.ts by scripts/genSearchDdl.ts - do not edit
-- by hand; run \`npm run db:generate\`. \`prefix='2 3'\` makes 2- and 3-character prefix queries index-backed,
-- which is what a search-as-you-type box issues; unicode61 folds capitalisation and diacritics.
${FTS_TABLE_DDL}`,
  ];
  for (const entry of SEARCH_INDEX) statements.push(...triggersFor(entry, sv));
  for (const entry of SEARCH_INDEX) statements.push(...backfillFor(entry, sv));
  return statements.join(`;\n${BREAK}\n`) + ";";
}

/** Marker the block in 0000 starts with. */
export const SEARCH_DDL_MARKER = "-- Global search index. GENERATED from src/domain/searchIndex.ts";

// ---------------------------------------------------------------------------------------------------------
// Across migrations. The same three questions changeDdl.ts answers for the stamp triggers: which search
// triggers do the migrations leave in place, which does the registry want, and what must the newest migration
// carry to close the gap.

const TRIGGER_STATEMENT = /DROP TRIGGER (?:IF EXISTS )?"(search_a[iud]_[a-z0-9_]+)"|CREATE TRIGGER "(search_a[iud]_[a-z0-9_]+)" AFTER (?:INSERT|UPDATE|DELETE) ON "[^"]+"(?:\nWHEN [^\n]*)? BEGIN\n[\s\S]*?\nEND/g;

function applyTriggerStatements(into: Map<string, string>, sql: string): Map<string, string> {
  for (const m of sql.matchAll(TRIGGER_STATEMENT)) {
    if (m[1]) into.delete(m[1]);
    else into.set(m[2]!, m[0]);
  }
  return into;
}

/** Every search trigger a piece of SQL creates, by name, as its CREATE statement (without the `;`). */
export const searchTriggersIn = (sql: string): Map<string, string> => applyTriggerStatements(new Map(), sql);

/** The search triggers the migrations leave in place, applied in file order (DROP removes, CREATE sets). */
export function appliedSearchTriggers(migrationsInOrder: readonly string[]): Map<string, string> {
  const applied = new Map<string, string>();
  for (const sql of migrationsInOrder) applyTriggerStatements(applied, sql);
  return applied;
}

/**
 * What a new migration has to carry so the applied triggers match the registry: DROP + CREATE for a trigger
 * whose body changed, a CREATE for a missing one, a DROP for one the registry no longer describes - and, for a
 * collection none of whose triggers existed before, the backfill that indexes the rows it already has. Empty
 * when they match. Each entry is one statement, ready to join with a statement breakpoint.
 *
 * A CHANGED trigger reindexes rows as they are next written, not the rows already in the index. That is the
 * right default for a tweak (a new match column); a change that must reach every existing row is a rebuild,
 * and is written by hand.
 */
export function searchDdlDelta(applied: ReadonlyMap<string, string>, sv: StateVisibility): string[] {
  const out: string[] = [];
  const backfills: string[] = [];
  for (const entry of SEARCH_INDEX) {
    const wanted = triggersFor(entry, sv).map((create) => [create.match(/CREATE TRIGGER "([^"]+)"/)![1]!, create] as const);
    if (wanted.every(([name]) => !applied.has(name))) {
      backfills.push(...backfillFor(entry, sv).map((s) => `${s.replace(/^INSERT INTO "search_docs"/, 'INSERT OR IGNORE INTO "search_docs"')};`));
    }
    for (const [name, create] of wanted) {
      const have = applied.get(name);
      if (have === create) continue;
      if (have !== undefined) out.push(`DROP TRIGGER IF EXISTS "${name}";`);
      out.push(`${create};`);
    }
  }
  const wantedNames = new Set(SEARCH_INDEX.flatMap((e) => triggersFor(e, sv).map((t) => t.match(/CREATE TRIGGER "([^"]+)"/)![1]!)));
  for (const name of applied.keys()) if (!wantedNames.has(name)) out.push(`DROP TRIGGER IF EXISTS "${name}";`);
  // Triggers first, then backfill: a row written between the two is then indexed by its trigger, and the
  // backfill skips it rather than indexing it twice - `OR IGNORE` on the doc (unique on collection + record)
  // and `NOT IN (SELECT rowid FROM search_fts)` on the text.
  return [...out, ...backfills];
}
