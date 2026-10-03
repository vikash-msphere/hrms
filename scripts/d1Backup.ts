// Logical backup of a D1 database: ONE consistent snapshot, written as SQL that restores into an EMPTY database,
// and proven to restore before it is written. Run nightly by .github/workflows/d1-backup.yml; see docs/deploy.md
// "Backups & disaster recovery".
//
//   Run:  node --import ./scripts/tsResolve.mjs scripts/d1Backup.ts --out hrms.sql.gz
//         [--database hrms] [--config wrangler.toml]   remote: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
//         [--local <file.sqlite>]                      a local SQLite file instead (rehearsal and checking)
//   An --out ending in .gz is gzipped; any other name gets plain SQL.
//
// Restore:  gunzip hrms.sql.gz && npx wrangler d1 execute <empty database> --remote --file=hrms.sql
//
// WHY NOT `wrangler d1 export`. D1 refuses to export any database that holds a virtual table ("cannot export
// databases with Virtual Tables (fts5)"). Its dump is SQLite's `.dump`, which writes FTS5 shadow tables through
// `PRAGMA writable_schema`, a pragma D1 does not allow. The global search index `search_fts` is an FTS5 table,
// and it cannot move to a database of its own: search is one query joining it to `search_docs` under the
// caller's scope, and D1 has no cross-database join. Cloudflare's workaround (drop the virtual table, export,
// recreate it) breaks every write in between on a live database, because the search triggers on ~60 tables
// insert into it. So this reads the database through the D1 query API and writes the dump itself.
//
// ONE TRANSACTION. The rows are read in a single REST call whose statements D1 runs as a batch, and a D1 batch is
// one transaction, executed sequentially and non-concurrently. The dump is therefore a point-in-time copy: a child
// row is never in it without the parent row it references. That matters because D1 enforces foreign keys, so a
// dump holding an orphan does not restore. Two small calls before it learn the tables and their columns. The
// snapshot reads sqlite_master again, and a schema that moved in between (a migration mid-run) starts the read
// over.
//
// VERIFIED BEFORE IT IS WRITTEN. The dump is restored into an in-memory SQLite (node:sqlite, which has FTS5) and
// checked: integrity_check, foreign_key_check, the FTS5 integrity-check, a row count per table against the rows
// read, the schema against the source, and every statement within D1's 100 KB limit. Any failure exits non-zero
// and writes nothing, so a backup that exists is one that restores.
//
// WHAT THE FILE HOLDS, IN ORDER:
//   1. `PRAGMA defer_foreign_keys`, so rows can arrive in table order rather than dependency order.
//   2. Every CREATE TABLE, including CREATE VIRTUAL TABLE. A virtual table's shadow tables (`search_fts_data`,
//      `_idx`, ...) are left out: creating the virtual table creates them.
//   3. Every row, as one INSERT per row. A virtual table's rows are dumped through the table itself, so the
//      restore rebuilds the index from its text.
//   4. Indexes, views and triggers LAST. A trigger created before the rows would fire on every restored INSERT,
//      which would index each searchable row a second time and rewrite every change stamp.
//
// ROWIDS ARE KEPT. `search_fts.rowid` equals the `search_docs` rowid (src/db/searchDdl.ts), and `search_docs` has
// no INTEGER PRIMARY KEY, so a plain INSERT would hand it fresh rowids and every search hit would join to the
// wrong record. Any table whose rowid is not already a column gets it written explicitly.
//
// VALUES ARE QUOTED BY SQLITE. Each value is read as `quote(col)`, so the literal in the dump is the one SQLite
// itself produces: exact 64-bit integers (JSON would round anything past 2^53, as D1's own export does), blobs as
// X'..', strings escaped. Nothing here formats a value.
//
// Left out: `_cf_*` (D1's own tables, which a read is refused on) and `sqlite_*` (`sqlite_sequence` is rebuilt
// from the restored rows, and the only AUTOINCREMENT table is d1_migrations; `sqlite_stat1` comes back with
// ANALYZE).
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

type Result = { rows: unknown[][]; rowsRead?: number; sizeAfter?: number };
/** Runs the statements as one transaction and returns each one's rows, in order. */
type Batch = (statements: string[]) => Promise<Result[]>;
type SchemaObject = { type: string; name: string; sql: string };
type Table = SchemaObject & { virtual: boolean; withoutRowid: boolean; columns: string[]; keepRowid: boolean };

// D1 refuses a statement longer than 100 KB, and a row is one statement on restore.
const D1_MAX_STATEMENT = 100_000;
// The shadow tables FTS3/4/5 and R*Tree create beside a virtual table, by suffix.
const SHADOW_SUFFIXES = ["data", "idx", "content", "docsize", "config", "segments", "segdir", "stat", "node", "rowid", "parent"];
// Every schema object the dump recreates. Automatic indexes have no SQL of their own; `_cf_*` and `sqlite_*` are
// left out for the reasons in the header.
const MASTER = `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE '!_cf!_%' ESCAPE '!' AND name NOT LIKE 'sqlite!_%' ESCAPE '!' ORDER BY rowid`;
// How many times a schema that moved during the read is read again before the run gives up.
const ATTEMPTS = 3;

// Bytes of D1 responses, for the run's log line: the snapshot is one response, and its size is what grows.
let responseBytes = 0;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const megabytes = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isVirtual = (o: SchemaObject) => /^CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql);
const toObjects = (rows: unknown[][]): SchemaObject[] => rows.map(([type, name, sql]) => ({ type: String(type), name: String(name), sql: String(sql) }));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(why: string): never {
  console.error(`d1Backup: ${why}`);
  process.exit(1);
}

/** The database_id of the named database in a wrangler config's `[[d1_databases]]` blocks. */
function databaseId(configPath: string, databaseName: string): string {
  const toml = readFileSync(configPath, "utf8");
  const block = toml
    .split(/^\[\[d1_databases\]\]/m)
    .slice(1)
    .map((b) => b.split(/^\[/m)[0]!)
    .find((b) => new RegExp(`^database_name\\s*=\\s*"${databaseName}"`, "m").test(b));
  const id = block?.match(/^database_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!id) fail(`no [[d1_databases]] entry named "${databaseName}" with a database_id in ${configPath}`);
  return id;
}

function remoteBatch(accountId: string, dbId: string, token: string): Batch {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/raw`;
  return async (statements) => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ batch: statements.map((sql) => ({ sql })) }),
      });
      const text = await res.text();
      let body: any = null;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: an edge error page. Reported below with its first bytes.
      }
      if (res.ok && body?.success) {
        const results: any[] = body.result ?? [];
        if (results.length !== statements.length) throw new Error(`D1 answered ${results.length} results for ${statements.length} statements`);
        responseBytes += text.length;
        return results.map((r) => ({ rows: r.results?.rows ?? [], rowsRead: Number(r.meta?.rows_read ?? 0), sizeAfter: r.meta?.size_after }));
      }
      // Rate limits and edge hiccups are worth a retry; a refused statement is not. Every statement is a read,
      // so running the batch again changes nothing.
      if ((res.status !== 429 && res.status < 500) || attempt === 4) {
        throw new Error(`D1 batch of ${statements.length} statement(s) failed (HTTP ${res.status}): ${body ? JSON.stringify(body.errors) : text.slice(0, 300)}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  };
}

function localBatch(file: string): Batch {
  const db = new DatabaseSync(file, { readOnly: true });
  return async (statements) => {
    // One read transaction: the local stand-in for a D1 batch.
    db.exec("BEGIN");
    try {
      return statements.map((sql) => ({ rows: db.prepare(sql).all().map((row) => Object.values(row)) }));
    } finally {
      db.exec("COMMIT");
    }
  };
}

/** The schema objects the dump recreates itself: everything but a virtual table's shadow tables. */
function ownObjects(objects: SchemaObject[]): SchemaObject[] {
  const shadows = new Set(objects.filter((o) => o.type === "table" && isVirtual(o)).flatMap((o) => SHADOW_SUFFIXES.map((s) => `${o.name}_${s}`)));
  return objects.filter((o) => !(o.type === "table" && shadows.has(o.name)));
}

function describe(t: SchemaObject, info: unknown[][]): Table {
  // PRAGMA table_info rows are (cid, name, type, notnull, dflt_value, pk). It leaves out generated and hidden
  // columns, which an INSERT cannot name anyway.
  const columns = info.map((r) => String(r[1]));
  const pk = info.filter((r) => Number(r[5]) > 0);
  const virtual = isVirtual(t);
  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(t.sql.slice(t.sql.lastIndexOf(")") + 1));
  // A sole INTEGER PRIMARY KEY is the rowid under another name, so the column already carries it. A WITHOUT ROWID
  // table has none to keep.
  const rowidIsColumn = !virtual && pk.length === 1 && String(pk[0]![2]).toUpperCase() === "INTEGER";
  return { ...t, virtual, withoutRowid, columns, keepRowid: !withoutRowid && !rowidIsColumn };
}

// One result column per value, aliased so every name is distinct, rather than one `||` chain per row: a wide
// table would otherwise be a deep expression.
function selectFor(t: Table): string {
  const values = [...(t.keepRowid ? ["rowid"] : []), ...t.columns.map(ident)];
  return `SELECT ${values.map((v, i) => `quote(${v}) AS "v${i}"`).join(", ")} FROM ${ident(t.name)}${t.withoutRowid ? "" : " ORDER BY rowid"}`;
}

async function snapshot(batch: Batch) {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const [master] = await batch([MASTER]);
    const objects = toObjects(master!.rows);
    const plain = ownObjects(objects).filter((o) => o.type === "table");
    if (plain.length === 0) throw new Error("the database has no tables");
    const infos = await batch(plain.map((t) => `PRAGMA table_info(${ident(t.name)})`));
    const tables = plain.map((t, i) => describe(t, infos[i]!.rows));

    const [again, ...data] = await batch([MASTER, ...tables.map(selectFor)]);
    if (JSON.stringify(toObjects(again!.rows)) === JSON.stringify(objects)) {
      const all = [master!, ...infos, again!, ...data];
      const rowsRead = all.every((r) => r.rowsRead !== undefined) ? all.reduce((n, r) => n + r.rowsRead!, 0) : undefined;
      return { objects, tables, data, rowsRead, sizeAfter: again!.sizeAfter };
    }
    console.error(`d1Backup: the schema changed while it was being read (attempt ${attempt} of ${ATTEMPTS})`);
  }
  throw new Error(`the schema changed during each of ${ATTEMPTS} attempts - is a migration running?`);
}

function render(objects: SchemaObject[], tables: Table[], data: Result[], source: string) {
  const out = [
    `-- D1 logical backup of ${source}, ${new Date().toISOString()}, written by scripts/d1Backup.ts: one transaction, verified to restore.`,
    `-- Restore into an EMPTY database: npx wrangler d1 execute <database> --remote --file=<this file>`,
    `PRAGMA defer_foreign_keys=TRUE;`,
  ];
  const oversized: string[] = [];
  const add = (statement: string, where: () => string) => {
    if (Buffer.byteLength(statement) > D1_MAX_STATEMENT) oversized.push(where());
    out.push(statement);
  };
  for (const t of tables) add(`${t.sql};`, () => t.name);
  tables.forEach((t, i) => {
    const head = `INSERT INTO ${ident(t.name)} (${[...(t.keepRowid ? ["rowid"] : []), ...t.columns].map(ident).join(", ")}) VALUES (`;
    // A row is named by its first value: the rowid, or else the table's first column (its key, in this schema).
    const firstName = t.keepRowid ? "rowid" : t.columns[0];
    for (const row of data[i]!.rows) add(`${head}${row.join(", ")});`, () => `${t.name} ${firstName}=${String(row[0]).slice(0, 40)}`);
  });
  for (const o of ownObjects(objects)) if (o.type !== "table") add(`${o.sql};`, () => o.name);
  return { sql: `${out.join("\n")}\n`, oversized };
}

/** Restores the dump into a scratch database and lists everything that would stop it restoring into D1. */
function verify(sql: string, objects: SchemaObject[], tables: Table[], data: Result[]): string[] {
  const problems: string[] = [];
  // Foreign keys are checked after the load by foreign_key_check, which names the rows, rather than enforced
  // during it, which stops at the first one and says nothing about it.
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  const rows = (q: string) => db.prepare(q).all().map((r) => Object.values(r));
  try {
    db.exec(sql);

    const integrity = rows("PRAGMA integrity_check").map((r) => String(r[0]));
    if (integrity.join("") !== "ok") problems.push(`integrity_check: ${integrity.slice(0, 5).join("; ")}`);

    // (table, rowid, parent, fkid) per orphan.
    const orphans = rows("PRAGMA foreign_key_check");
    if (orphans.length) {
      const first = orphans.slice(0, 5).map(([table, rowid, parent]) => `${table} rowid ${rowid} -> ${parent}`).join(", ");
      problems.push(`foreign_key_check: ${orphans.length} row(s) reference a missing parent: ${first}`);
    }

    for (const t of tables.filter((t) => t.virtual && /\bUSING\s+fts5\b/i.test(t.sql))) {
      try {
        db.exec(`INSERT INTO ${ident(t.name)} (${ident(t.name)}) VALUES ('integrity-check')`);
      } catch (err) {
        problems.push(`${t.name}: FTS5 integrity-check failed: ${message(err)}`);
      }
    }

    tables.forEach((t, i) => {
      const restored = Number(rows(`SELECT count(*) FROM ${ident(t.name)}`)[0]![0]);
      const read = data[i]!.rows.length;
      if (restored !== read) problems.push(`${t.name}: ${restored} rows restored, ${read} read`);
    });

    const key = (o: SchemaObject) => `${o.type} ${o.name}\n${o.sql}`;
    const want = new Set(ownObjects(objects).map(key));
    const got = new Set(ownObjects(toObjects(rows(MASTER))).map(key));
    const differ = [...want].filter((k) => !got.has(k)).concat([...got].filter((k) => !want.has(k)));
    if (differ.length) problems.push(`the restored schema differs from the source: ${differ.slice(0, 5).map((k) => k.split("\n")[0]).join(", ")}`);
  } catch (err) {
    problems.push(`the dump does not apply: ${message(err)}`);
  } finally {
    db.close();
  }
  return problems;
}

async function main() {
  const out = arg("out") ?? fail("--out <file> is required");
  const local = arg("local");
  let batch: Batch;
  let source: string;
  if (local) {
    source = resolve(local);
    batch = localBatch(source);
  } else {
    const token = process.env.CLOUDFLARE_API_TOKEN ?? fail("CLOUDFLARE_API_TOKEN is not set");
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? fail("CLOUDFLARE_ACCOUNT_ID is not set");
    source = arg("database") ?? "hrms";
    batch = remoteBatch(accountId, databaseId(resolve(arg("config") ?? "wrangler.toml"), source), token);
  }

  const { objects, tables, data, rowsRead, sizeAfter } = await snapshot(batch);
  const { sql, oversized } = render(objects, tables, data, source);
  const problems = verify(sql, objects, tables, data);
  if (oversized.length) {
    problems.push(`${oversized.length} statement(s) exceed D1's 100 KB statement limit, so the restore would refuse them: ${oversized.slice(0, 10).join(", ")}`);
  }
  if (problems.length) fail(`the dump failed verification, so nothing was written:\n  ${problems.join("\n  ")}`);

  const file = out.endsWith(".gz") ? gzipSync(sql) : Buffer.from(sql);
  writeFileSync(out, file);

  const rowCount = data.reduce((n, r) => n + r.rows.length, 0);
  const largest = tables
    .map((t, i) => [t.name, data[i]!.rows.length] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, n]) => `${name} ${n}`)
    .join(", ");
  const dbSize = local ? statSync(source).size : sizeAfter;
  console.error(
    `d1Backup: verified ${tables.length} tables, ${rowCount} rows, ${ownObjects(objects).length - tables.length} indexes/views/triggers -> ${out}\n` +
      `  dump ${megabytes(Buffer.byteLength(sql))}, written ${megabytes(file.length)}` +
      (dbSize === undefined ? "" : `; database ${megabytes(Number(dbSize))}`) +
      (local ? "" : `; D1 responses ${megabytes(responseBytes)}`) +
      (rowsRead === undefined ? "" : `; ${rowsRead} rows read`) +
      `\n  largest: ${largest}`,
  );
}

main().catch((err) => fail(message(err)));
