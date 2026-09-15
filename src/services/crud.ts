// Generic CRUD over one table: the shape ~40 collections repeat verbatim (list with the soft-delete filter +
// cursor paging, get, create with an allocated flat code, patch with If-Match + an audit diff, soft
// delete/restore/purge). Nothing here is new behavior - it is composed from the helpers the hand-written
// services already call (softDelete.ts, lifecycle.ts, pagination.ts, audit.ts, codeAlloc.ts), so a converted
// collection keeps its wire contract. What a collection actually OWNS is the 10% in its spec: which wire field
// maps to which column (`insert` / `patch`) and what makes a write invalid.
//
// This makes NO access decision: the middleware is still the single source of authorization, exactly as when
// each service was written by hand. `assertNotLocked` is a workflow precondition, not access control.
import { and, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { CODE_WIDTH, allocFlatCode, withFreshCode } from "./codeAlloc";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, createdMeta, diffMeta } from "../lib/audit";
import { notFound, aborted, alreadyExists, unimplemented, invalidArgument, errorChainText } from "../lib/errors";

// The shape of an internal resource id: 8 random bytes in Crockford base32 (lib/idCodec genId). The only id a
// caller-supplied `?id` may be, since it becomes the row's primary key.
const INTERNAL_ID_RE = /^[0-9a-hj-km-np-tv-z]{13}$/;
import { etagOf } from "../http/serialize";
import { softDeleteRow, restoreRow, purgeRow, type PurgeCascade } from "./softDelete";
import { keysetPage } from "./keysetPage";
import { applyScope } from "./listScope";
import { publicStateFilter } from "./stateFilter";
import type { ListScope } from "../domain/access";
import { assertNotLocked } from "./lockGuard";

// A drizzle table, kept indexable: the generic helpers here reach for the standard columns by name
// (`table.uuid`, `table.deleteTime`) the way services/softDelete.ts does, while `$inferInsert` still resolves to
// THIS table's columns - which is what puts a compiler under a spec's column mapping.
export type CrudTable = SQLiteTable & Record<string, any>;
type Table = CrudTable;
/**
 * The columns a spec's `insert` / `patch` may set: this table's insert shape, every key optional (a patch sets
 * only what the caller sent). A mistyped column name is a compile error here instead of a value that silently
 * never lands or a D1 failure at runtime.
 */
export type SetOf<T extends Table> = Partial<T["$inferInsert"]>;
/**
 * What a spec's `insert` may return: `SetOf<T>` with `code` and `uuid` made unwritable.
 *
 * Both are IDENTITY, and the factory owns them. `code` is the authz scope key every access decision is made
 * against (domain/codes.ts), allocated here by `allocCode`; `uuid` is the primary key, settable only through
 * the validated `?id`. They used to be ordinary keys of the return type that the `{ code, ...values }` spread
 * let a mapper quietly win - a spec returning `code` would bypass allocation and take whatever the wire
 * supplied, placing its rows in a scope of the caller's choosing. The `?id` case already had a runtime guard
 * and a comment; this is the same defence for its twin, moved to compile time where a converted collection
 * cannot get it wrong in the first place.
 *
 * A plain `Omit`, deliberately, not `& { code?: never }`: the intersection also rejects the many mappers whose
 * return type is INFERRED as the full `Partial<$inferInsert>` (they build the object then return it), which is
 * noise rather than a finding. `Omit` still fails the case that matters - a mapper returning an object literal
 * with `code` in it, which is how every real spec is written - via excess-property checking. The `values` spread
 * in `create` puts identity last, so the inferred-return path cannot land one either.
 */
export type InsertOf<T extends Table> = Omit<SetOf<T>, "code" | "uuid">;
type Row = {
  uuid: string;
  code: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
  deleteTime?: Date | number | null;
  locked?: boolean | null;
  [k: string]: unknown;
};

export type CrudSpec<I, T extends Table = Table> = {
  table: T;
  /** Wire collection (`pay-grades`) - the audit entity and the access-hint key. */
  collection: string;
  /** Audit action stem and the `<name> not found` text the shared soft-delete helpers raise (`pay_grade`). */
  auditName: string;
  /** 404 detail for get/update, phrased for a human (`pay grade not found`). */
  notFound: string;
  /**
   * Wire input -> insert columns. Throws `invalidArgument` for a missing/unparseable required field.
   * OMIT for a collection that is not created through its own endpoint (an acknowledgement is written by
   * org-documents :acknowledge; a leave balance is accrued) - the factory then mounts no POST at all, so the
   * absence of a create is expressed once, here, instead of as a missing route somebody has to notice.
   */
  insert?: (input: I, deps: Deps, actor: AppUser) => InsertOf<T> | Promise<InsertOf<T>>;
  /**
   * Wire patch -> the `set` object: ONLY keys the caller actually sent (see `has`), so a diff stays honest.
   * Async when a field has to be resolved against another table (a reference the write must validate).
   * OMIT for a read-only collection (an event-log row is history; a cron run is a record of what happened).
   */
  patch?: (input: I, row: any, deps: Deps, actor: AppUser) => InsertOf<T> | Promise<InsertOf<T>>;
  /**
   * Presentation order WITHIN a page. The DB always pages in the cursor's own (createdAt, uuid) order - that is
   * what makes a page boundary stable - and this reorders the rows of one page before they are serialized.
   * A catalog that is expected to exceed a page should be ordered client-side instead.
   */
  sort?: (a: any, b: any) => number;
  /**
   * Which end of the collection one page is a window ON: newest-first (the default) or oldest-first. Only set
   * "asc" for a list a caller reads forwards through time; see keysetPage for why newest-first is the default.
   */
  listDir?: "asc" | "desc";
  /**
   * Per-caller decoration of the returned rows (a holiday's own selection, a board's card count). Receives the
   * whole PAGE, so it costs one query per response rather than one per row. APPLIED BY THE FACTORY
   * (http/collectionRoute.ts), not here: an `overrides` entry replaces a method in this service wholesale, and
   * derived data must survive that.
   *
   * `scope` is the middleware's already-decided list scope for this request (the same one applyScope binds to
   * columns). It is here so a decoration can SHAPE the payload by the breadth the middleware settled on - a
   * self-service reader gets a different amount of detail than payroll - without a service re-deciding
   * anything. Item reads carry it too (the middleware sets it for every collection request).
   */
  decorate?: (deps: Deps, actor: AppUser, rows: any[], scope: ListScope | undefined) => Promise<any[]>;
  /** Side effects the write owes the rest of the system (notify, re-accrue, emit an event). Run after the audit row. */
  afterCreate?: (deps: Deps, actor: AppUser, row: any, input: I) => Promise<void>;
  afterUpdate?: (deps: Deps, actor: AppUser, row: any, before: any, patch: I) => Promise<void>;
  /**
   * Code allocation, when the resource is not a flat one (owned/dept-scoped tables). Receives the resolved
   * insert values, since an owned code is allocated under the row's owner.
   *
   * `attempt` is `withFreshCode`'s retry number (1 on the first try). Past 1 the scope's counter is
   * re-established from what is actually stored before a number is taken - a counter left behind by a seed
   * script hands out codes already on disk, and retrying without that resync only walks it one place per
   * attempt and never catches up. See services/codeAlloc.ts#reserve. An allocator that does not care may
   * simply omit the parameter.
   */
  allocCode?: (deps: Deps, table: Table, values: SetOf<T>, attempt: number) => Promise<string>;
  /**
   * What a HARD purge (`DELETE ?force=true`) takes with it: the sub-resource rows that only exist as part of
   * this one, and the columns elsewhere that merely point at it. See services/softDelete.ts#PurgeCascade.
   *
   * Undeclared references still block the purge - deliberately - and now answer 409 with a reason instead of
   * failing the request as an unhandled 500 out of SQLite.
   */
  purgeCascade?: PurgeCascade;
};

export type CrudService<I> = {
  /**
   * `scope` is the row filter the authz middleware decided for this request (`c.get("scope")`), bound to
   * columns here and nowhere else. It is required, not optional: an absent scope is a request the middleware
   * did not scope, and `applyScope` answers no rows for it rather than the whole table.
   */
  list: (deps: Deps, actor: AppUser, scope: ListScope | undefined, maxPageSize: number, pageToken?: string, showDeleted?: boolean, deletedOnly?: boolean) => Promise<{ items: any[]; nextPageToken?: string }>;
  get: (deps: Deps, actor: AppUser, id: string) => Promise<any>;
  create: (deps: Deps, actor: AppUser, input: I, id?: string) => Promise<any>;
  update: (deps: Deps, actor: AppUser, id: string, patch: I, ifMatch?: string) => Promise<any>;
  remove: (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => Promise<void>;
  restore: (deps: Deps, actor: AppUser, id: string) => Promise<any>;
  purge: (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => Promise<void>;
};

/** Did the caller actually send this key? A PATCH of `{x: undefined}` clears x; an absent x leaves it alone. */
export const has = <T extends object>(patch: T, key: keyof T) => Object.prototype.hasOwnProperty.call(patch, key);

export function crudService<I, T extends Table = Table>(spec: CrudSpec<I, T>): CrudService<I> {
  const { table, collection, auditName } = spec;
  // allocFlatCode's third parameter is a width, not the values bag - bind it explicitly. The fourth is the
  // resync flag, which is the retry's: past the first attempt the scope is re-read rather than trusted (see
  // CrudSpec.allocCode).
  const alloc = spec.allocCode ?? ((deps: Deps, t: Table, _values: SetOf<T>, attempt: number) => allocFlatCode(deps, t, CODE_WIDTH.flat, attempt > 1));

  const required = async (deps: Deps, id: string): Promise<Row> => {
    const row = (await deps.db.select().from(table).where(eq(table.uuid, id)).limit(1))[0] as unknown as Row | undefined;
    if (!row) throw notFound(spec.notFound);
    return row;
  };

  return {
    // One page, ordered and seeked in SQL. The soft-delete filter is skipped entirely for a table with no
    // `delete_time` column (an append-only collection), and the page token carries the WIRE token for the row
    // rather than its internal uuid - both handed over by keysetPage, which is what the 25 hand-written scoped
    // lists already use. `sort` then presents within the page (see CrudSpec.sort).
    //
    // The caller's scope is bound the same way every hand-written list binds it: applyScope maps the breadth
    // the middleware DECIDED onto this table's columns and decides nothing itself. A generic-list table is a
    // flat catalog with a `code` and no owner column, so a scoped-to-`own` caller correctly gets nothing -
    // fail closed, rather than the whole table a missing scope check used to hand back.
    async list(deps, actor, scope, maxPageSize, pageToken, showDeleted = false, deletedOnly = false) {
      const conds = [applyScope(scope, table.code, undefined)];
      // State-gated visibility, bound the same way the breadth is: the middleware already decided whether this
      // caller may see restricted rows (`scope.seeRestricted`), and this maps that onto the collection's own
      // columns. Undefined for the collections with no state rule, which is almost all of them.
      // Read STRICTLY off the manifest. A principal without one is a bug, not a case to tolerate: every auth
      // lane sets `policy`, and softening this to `actor.policy?.` would silently drop the filter, which is a
      // visibility leak in its own right - a draft's title in a list is the disclosure, whether or not the row
      // can then be opened.
      conds.push(publicStateFilter(actor.policy.state_visibility?.[collection], table, scope?.seeRestricted ?? false));
      // Three states, not two: exclude the trash (the default), include it, or ask for it ALONE - the last is
      // what makes a "Deleted" view a fetch of its own instead of a filter over a page of mostly-live rows.
      if (table.deleteTime) {
        if (deletedOnly) conds.push(isNotNull(table.deleteTime));
        else if (!showDeleted) conds.push(isNull(table.deleteTime));
      }
      const { items, nextPageToken } = await keysetPage<Row>(deps, table, collection, and(...conds.filter(Boolean) as SQL[]), {
        dir: spec.listDir,
        max: maxPageSize,
        pageToken,
      });
      return { items: spec.sort ? [...items].sort(spec.sort) : items, nextPageToken };
    },

    get: (deps, _actor, id) => required(deps, id),

    async create(deps, actor, input, id) {
      if (!spec.insert) throw unimplemented(`${collection} are not created directly`);
      // A caller-chosen `?id` lands in the PRIMARY KEY, so it has to be an id this app can round-trip: the
      // outbound wire edge only tokenizes a 13-char base32 internal id (middleware/encodeWireIds REF_RE), so
      // any other spelling silently creates a row whose id is published raw and never becomes a wire token.
      // Refusing it is also the only thing standing between the caller and an arbitrary-length PK.
      if (id !== undefined && !INTERNAL_ID_RE.test(id)) throw invalidArgument("`id` must be a 13-character base32 resource id");
      // `InsertOf` narrows what a SPEC may hand back; inside the factory the value is an ordinary column bag
      // again. Omit over a generic `T["$inferInsert"]` does not resolve to a concrete key set, so the two
      // consumers below need the un-narrowed shape - the constraint's whole job is at the spec boundary above.
      const values = (await spec.insert(input, deps, actor)) as SetOf<T>;
      // Allocated INSIDE the retry: a create that loses the code race re-reads the scope and composes the
      // next code rather than handing the caller a 409 to press again (services/codeAlloc.ts withFreshCode).
      // Two people adding a record at the same moment is an ordinary Tuesday.
      const row = await withFreshCode(async (attempt) => {
        const code = await alloc(deps, table, values, attempt);
        try {
          // Identity spreads LAST, after the spec's columns: the allocated `code` is the code and an explicit
          // `?id` is the id, so neither can be shadowed by a mapper. `InsertOf` already makes both a compile
          // error in a spec, and this is the belt to that braces - an `as any` at one call site should not be
          // able to reach the authz scope key.
          return ((await deps.db
            .insert(table)
            .values({ ...values, code, ...(id ? { uuid: id } : {}) })
            .returning()) as unknown as Row[])[0]!;
        } catch (e) {
          // A caller-supplied `?id` that is already taken is a CONFLICT, not a server fault - the resource it
          // names exists. Without this the raw D1 constraint error surfaces as a 500. Translated before the
          // retry sees it: re-allocating a code would not free the id, so that collision is never worth
          // another go, and an AppError is not a code collision.
          if (id && /UNIQUE|PRIMARY KEY|constraint/i.test(errorChainText(e))) throw alreadyExists(`${collection}/${id} already exists`);
          throw e;
        }
      });
      // What the record was made AS, not just that it was made. A create used to be the one write in the app
      // whose trail said nothing about its content, which is the write you most often want to read back.
      await audit(deps, actor, `${auditName}.create`, collection, row.uuid, createdMeta(row, collection), row);
      if (spec.afterCreate) await spec.afterCreate(deps, actor, row, input);
      // The factory decorates the response like a read, so a write answers with the same resource shape a GET
      // would - a derived field (an expense budget's spend, a holiday's own selection) is never missing.
      return row;
    },

    async update(deps, actor, id, patch, ifMatch) {
      if (!spec.patch) throw unimplemented(`${collection} cannot be edited`);
      const row = await required(deps, id);
      // A row in the trash is not editable: restore it first. (A GET still resolves it, so `?show_deleted`
      // views and audit links keep working.)
      if (row.deleteTime) throw notFound(spec.notFound);
      assertNotLocked(row);
      if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
      const set: Record<string, unknown> = { updatedAt: new Date(), ...(await spec.patch(patch, row, deps, actor)) };
      // COMPARE-AND-SWAP, not read-then-write: the version the ETag was computed from is part of the WHERE, so
      // the DB decides whether this write still applies. Checking `ifMatch` above against the row we just read
      // cannot do that - two callers holding the same ETag both pass it, both write, both get 200, and the
      // first one's change is gone with nothing saying so. That is the exact guarantee the SPA promises: it
      // sends If-Match on every patch (web/src/api.ts) and has a message for the conflict
      // (web/src/lib/problemText.ts), which could never fire while the version stayed out of the WHERE.
      //
      // It also covers what a millisecond-granularity ETag cannot: Workers freezes `Date.now()` between I/O,
      // so two writes can land the same `updated_at` and therefore the same ETag. The guard is the version
      // itself, not our comparison of it.
      const updated = ((await deps.db
        .update(table)
        .set(set)
        .where(and(eq(table.uuid, id), eq(table.updatedAt, new Date(row.updatedAt))))
        .returning()) as unknown as Row[])[0] as Row | undefined;
      // No row matched, for one of two reasons, and they are different answers: the row was hard-purged
      // between the read and the write (404 - it is gone, retrying will not help), or its version moved under
      // us (409 - it is there, re-read and re-apply). One read on this path only, which a conflict can afford,
      // buys the honest status code instead of collapsing both into a guess.
      //
      // The 409 is raised for a caller who sent NO If-Match too: opting out of optimistic concurrency is a
      // request not to be bothered about a stale read, not permission to clobber a write you never saw.
      if (!updated) {
        const still = (await deps.db.select({ uuid: table.uuid }).from(table).where(eq(table.uuid, id)).limit(1))[0];
        if (!still) throw notFound(spec.notFound);
        throw aborted("the record changed since it was read; re-read it and try again");
      }
      await audit(deps, actor, `${auditName}.update`, collection, id, diffMeta(row, updated, set, collection), updated);
      if (spec.afterUpdate) await spec.afterUpdate(deps, actor, updated, row, patch);
      return updated;
    },

    remove: (deps, actor, id, ifMatch) => softDeleteRow(deps, actor, table, auditName, collection, id, ifMatch),
    restore: (deps, actor, id) => restoreRow(deps, actor, table, auditName, collection, id),
    purge: (deps, actor, id, ifMatch) => purgeRow(deps, actor, table, auditName, collection, id, ifMatch, undefined, spec.purgeCascade),
  };
}
