import type { MiddlewareHandler } from "hono";
import { and, eq, lt } from "drizzle-orm";
import type { AppEnv } from "../env";
import type { Deps } from "../deps";
import * as schema from "../db/schema";
import { invalidArgument } from "../lib/errors";

// A write sent twice lands once.
//
// A connection can be lost on either side of the Worker: before the request arrives (nothing happened) or after
// the Worker answered (the write happened, the answer did not arrive). The client cannot tell which, so it could
// never safely ask again - and a create or a `:submit` that dropped left the person looking at an error for a
// write that may well have landed. With a key the client CAN ask again (web/src/api.ts sends one on every write
// and re-sends it with the retry): the first copy's answer is kept here, and a later copy with the same key is
// handed that answer instead of doing the work a second time.
//
// Only a SUCCESS is kept. A refusal (4xx) or a failure (5xx) releases the key, so the retry runs fresh - it
// either gets the same refusal again, which is right, or succeeds where a transient failure did not.
//
// A copy arriving while the first is still running is answered 409 with `Retry-After`: the first copy's answer
// is not known yet, and running the work alongside it is exactly what the key exists to prevent.
//
// Mounted after authz, so a refused request never claims a key, and inside the outbound wire-id edge, so the
// stored body holds internal ids and a replay is encoded on the way out exactly as the original was.

const HEADER = "Idempotency-Key";
const KEY_SHAPE = /^[A-Za-z0-9_-]{8,100}$/;
const WRITES = new Set(["POST", "PATCH", "PUT"]);
// A replayed answer is a JSON document a client folds in; a body past this is not worth a D1 row, and the write
// simply is not replayable (the retry runs fresh, as it did before keys existed).
const MAX_BODY = 256 * 1024;
const KEPT_HEADERS = ["Content-Type", "ETag", "Location"];

export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header(HEADER);
  if (!key || !WRITES.has(c.req.method)) return next();
  if (!KEY_SHAPE.test(key)) throw invalidArgument(`${HEADER} must be 8-100 characters of A-Z, a-z, 0-9, "-" or "_"`);

  const user = c.get("user");
  if (!user) return next();
  // The client that minted the key: an API key is its own client, anything else is the signed-in person.
  const principal = user.apiKey ? `k:${user.apiKey.uuid}` : `u:${user.uuid}`;
  const url = new URL(c.req.url);
  const path = url.pathname + url.search;
  const method = c.req.method;
  const deps = c.get("deps");
  const db = deps.db;
  const t = schema.idempotencyKeys;
  const mine = and(eq(t.principal, principal), eq(t.key, key));

  const claimed = await db
    .insert(t)
    .values({ principal, key, method, path, status: 0, createdAt: deps.clock.now() })
    .onConflictDoNothing()
    .returning({ key: t.key });
  if (claimed.length === 0) {
    const row = (await db.select().from(t).where(mine).limit(1))[0];
    if (row && (row.method !== method || row.path !== path)) {
      throw invalidArgument(`this ${HEADER} was already used for a different request`);
    }
    if (!row || row.status === 0) {
      // Still running (or released a moment ago): say so, and when to ask again.
      return new Response(
        JSON.stringify({ type: "/errors/aborted", title: "Aborted", status: 409, detail: "the same request is still being processed - try again in a moment" }),
        { status: 409, headers: { "Content-Type": "application/problem+json", "Retry-After": "1" } },
      );
    }
    const headers = new Headers(JSON.parse(row.headersJson ?? "{}") as Record<string, string>);
    headers.set("Idempotent-Replayed", "true");
    // A 204 is a null-body status; a Response refuses a body for it, even an empty one.
    return new Response(row.status === 204 || row.status === 205 ? null : row.body, { status: row.status, headers });
  }

  const release = () => db.delete(t).where(mine);
  try {
    await next();
  } catch (e) {
    await release();
    throw e;
  }
  const res = c.res;
  const type = res.headers.get("Content-Type") ?? "";
  const storable = res.status >= 200 && res.status < 300 && (type === "" || type.includes("json"));
  const body = storable ? await res.clone().text() : "";
  if (!storable || body.length > MAX_BODY) {
    await release();
    return;
  }
  const kept: Record<string, string> = {};
  for (const h of KEPT_HEADERS) {
    const v = res.headers.get(h);
    if (v) kept[h] = v;
  }
  await db.update(t).set({ status: res.status, headersJson: JSON.stringify(kept), body }).where(mine);
};

/** The nightly sweep (cron.ts): a retry arrives within seconds of the write it repeats, so a day-old key is
 *  answering nobody. One statement - the table holds a day of writes, not a history.
 *
 *  Counted from `meta.changes`, not `RETURNING`: a DELETE with RETURNING cannot delete in one pass, so SQLite
 *  collects the rowids first, seeks each row again, and copies every returned value through a temp table that
 *  D1 bills as rows read and written. */
export async function sweepIdempotencyKeys(deps: Deps): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - 24 * 60 * 60 * 1000);
  const res = await deps.db.delete(schema.idempotencyKeys).where(lt(schema.idempotencyKeys.createdAt, cutoff)).run();
  return res.meta.changes;
}
