import { eq, and, isNull, isNotNull, gt, or, sql, type SQL } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import type { ListScope } from "../domain/access";
import { applyScope } from "./listScope";
import { keysetPage } from "./keysetPage";
import { audit } from "../lib/audit";
import { invalidArgument, notFound, aborted, failedPrecondition, forbidden } from "../lib/errors";
import { isSuperGrant } from "../domain/grants";
import { etagOf } from "../http/serialize";
import { assertKeyName } from "../lib/apiKeyToken";
import { parseScope, scopeToWire, type KeyScope } from "../domain/keyScope";
import { COLLECTIONS } from "../domain/collections";

// Machine credentials. Access to this collection is decided by the middleware like any other; what lives
// here is the credential lifecycle itself.
//
// Two rules this service enforces that no access rule can express:
//   - a key's OWNER must be an active user, and a caller who is not super may only mint keys for themselves
//     (otherwise "mint a key for the CEO" would be a privilege-escalation primitive);
//   - the plaintext secret leaves the building exactly once, in the create response.

export type ApiKeyInput = {
  display_name?: string;
  description?: string | null;
  owner?: string; // "users/<internal id>" after the inbound wire decode
  scope?: unknown; // WireScope, validated here
  expire_time?: string;
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// The default when a create omits `scope`: read-only across every collection, no custom methods. A key
// should start as weak as is still useful, and be widened deliberately.
const DEFAULT_SCOPE: KeyScope = { collections: "*", maxLevel: "read", verbs: [] };

// `q` is matched HERE rather than over the client's cached page, which is the only way a search can reach a
// key past the first page. Deliberately a plain substring match over the labels and the public prefix, not the
// FTS index: this collection is not in it, and adding credentials to the app-wide search index is a bigger
// decision than a filter box.
// `%` and `_` inside the needle are escaped, not stripped: a key described as "50% sampler" must search for
// what was typed. Same rule (and the same ESCAPE clause) as the saved-grid filter in services/tableRun.ts.
// The backslash goes first, or a needle ending in one would escape the closing `%` this builds.
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (ch) => `\\${ch}`);

export async function listApiKeys(deps: Deps, _actor: AppUser, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted = false, q?: string, deletedOnly = false) {
  // THE CALLER'S SCOPE IS BOUND HERE. This used to take the actor and ignore it (`_actor`) and read the whole
  // table. The breadth is the lesser half of what that skipped: `scope` also carries the caller's per-object
  // shares and DENIES (resolved by middleware/authz.ts for every collection-level list), and `applyScope` is
  // the only thing that binds them - so a per-object deny on a credential had no effect on this list.
  // `api-keys` is a flat catalog with a `code` and no owner column, so an own-scoped caller gets nothing.
  const conds: (SQL | undefined)[] = [applyScope(scope, schema.apiKeys.code, undefined)];
  if (deletedOnly) conds.push(isNotNull(schema.apiKeys.deleteTime));
  else if (!showDeleted) conds.push(isNull(schema.apiKeys.deleteTime));
  // Matched in SQL rather than over the fetched rows, for the reason above it: the page has to be the page
  // AFTER the filter, or a search past the first page seeks into a different result set than it renders.
  const needle = (q ?? "").trim().toLowerCase();
  if (needle) {
    const pat = `%${likeEscape(needle)}%`;
    conds.push(
      or(
        sql`lower(${schema.apiKeys.name}) like ${pat} escape '\\'`,
        sql`lower(coalesce(${schema.apiKeys.description}, '')) like ${pat} escape '\\'`,
        sql`lower(${schema.apiKeys.prefix}) like ${pat} escape '\\'`,
      ),
    );
  }
  return keysetPage<typeof schema.apiKeys.$inferSelect>(deps, schema.apiKeys, "api-keys", and(...conds.filter(Boolean) as SQL[]), {
    max: maxPageSize,
    pageToken,
  });
}

async function getApiKey(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.uuid, id)).limit(1))[0];
  if (!row) throw notFound("api key not found");
  return row;
}

// Mint a credential. Returns the row PLUS the plaintext token, which the route serializes once and then
// drops on the floor - only the HMAC is stored, so there is no second chance to read it.
export async function createApiKey(deps: Deps, actor: AppUser, input: ApiKeyInput, id?: string) {
  const name = assertKeyName(input.display_name);

  // A key may never mint a key. Otherwise a narrow key with write access to this collection could mint an
  // unrestricted one for its own owner and escape its ceiling entirely - the scope system would be a
  // suggestion. Minting is a human act.
  if (actor.apiKey) throw forbidden("an API key may not create API keys");

  const ownerId = idFromPath(input.owner) ?? actor.uuid;
  // Minting FOR SOMEONE ELSE is the escalation-shaped operation ("give me a key that acts as the CEO"), so
  // it is reserved for the break-glass identity. Everyone else may only delegate their own authority.
  if (ownerId !== actor.uuid && !isSuperGrant(actor.grant)) throw forbidden("only a super admin may mint a key for another user");

  const owner = (await deps.db.select().from(schema.users).where(eq(schema.users.uuid, ownerId)).limit(1))[0];
  if (!owner) throw invalidArgument("owner must be an existing user");
  if (owner.status !== "active") throw failedPrecondition("owner is disabled");

  const scope = input.scope === undefined ? DEFAULT_SCOPE : parseScope(input.scope, COLLECTIONS);
  if (!scope) throw invalidArgument("scope must be { collections: [..] | \"*\", max_level: read|write|admin, verbs: [..] | \"*\" }");

  let expiresAt: Date | null = null;
  if (input.expire_time) {
    const ms = Date.parse(input.expire_time);
    if (Number.isNaN(ms)) throw invalidArgument("expire_time must be an RFC 3339 timestamp");
    if (ms <= deps.clock.now().getTime()) throw invalidArgument("expire_time must be in the future");
    expiresAt = new Date(ms);
  }

  const minted = await deps.apiKeySigner.mint();
  const row = (
    await deps.db
      .insert(schema.apiKeys)
      .values({
        code: await allocFlatCode(deps, schema.apiKeys),
        ...(id ? { uuid: id } : {}), // the primary key; `{ id }` named no column, so the caller's id was dropped
        name,
        description: input.description?.trim() || null,
        ownerUserId: owner.uuid,
        prefix: minted.prefix,
        hash: minted.hash,
        scopeJson: JSON.stringify(scopeToWire(scope)),
        expiresAt,
        createdBy: actor.uuid,
      })
      .returning()
  )[0]!;

  // The audit row records WHAT was minted and for whom. It must never record the token or the hash.
  await audit(deps, actor, "api_key.create", "api-keys", row.uuid, { owner: owner.email, prefix: row.prefix, scope: scopeToWire(scope) }, row);
  return { row, token: minted.token };
}

// Revoke: the credential stops working on the very next request (the auth lane reads this row live and never
// caches it). The row itself stays so the audit trail can still name the key that did things.
export async function revokeApiKey(deps: Deps, actor: AppUser, id: string) {
  const row = await getApiKey(deps, actor, id);
  if (row.revokedAt) return row; // idempotent
  const updated = (
    await deps.db
      .update(schema.apiKeys)
      .set({ revokedAt: deps.clock.now(), updatedAt: deps.clock.now() })
      .where(eq(schema.apiKeys.uuid, id))
      .returning()
  )[0]!;
  await audit(deps, actor, "api_key.revoke", "api-keys", id, { prefix: row.prefix }, updated);
  return updated;
}

// Hard delete. There is no soft-delete lane here on purpose: a "deleted but restorable" credential is a
// credential, and restore would resurrect a working secret. Revoke is the reversible-looking operation;
// delete is final.
// The auth lane's lookup: one indexed read by prefix, restricted to keys that are live RIGHT NOW. Never
// cached - see middleware/auth.ts.
export function findLiveKeyByPrefix(deps: Deps, prefix: string, now: Date) {
  return deps.db
    .select()
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.prefix, prefix),
        isNull(schema.apiKeys.revokedAt),
        // Soft-deleted counts as gone. A deleted credential that still authenticated would make DELETE a
        // cosmetic act - the one outcome nobody expects from it.
        isNull(schema.apiKeys.deleteTime),
        or(isNull(schema.apiKeys.expiresAt), gt(schema.apiKeys.expiresAt, now)),
      ),
    )
    .limit(1);
}

// `last_used_at` is a convenience column, not an audit record, so it is written at most once every 15
// minutes per key. A write per request would add a D1 write to every machine call for a field nobody reads
// at that resolution.
export const LAST_USED_THROTTLE_MS = 15 * 60 * 1000;

export function shouldTouchLastUsed(lastUsedAt: Date | number | null, nowMs: number): boolean {
  return lastUsedAt === null || nowMs - +new Date(lastUsedAt) > LAST_USED_THROTTLE_MS;
}

export function touchLastUsed(deps: Deps, id: string, now: Date) {
  return deps.db.update(schema.apiKeys).set({ lastUsedAt: now }).where(eq(schema.apiKeys.uuid, id));
}
