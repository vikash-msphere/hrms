// Generic CRUD over one table: the shape ~40 collections repeat verbatim (list with the soft-delete filter +
// cursor paging, get, create with an allocated flat code, patch with If-Match + an audit diff, soft
// delete/restore/purge). Nothing here is new behavior - it is composed from the helpers the hand-written
// services already call (softDelete.ts, lifecycle.ts, pagination.ts, audit.ts, codeAlloc.ts), so a converted
// collection keeps its wire contract. What a collection actually OWNS is the 10% in its spec: which wire field
// maps to which column (`insert` / `patch`) and what makes a write invalid.
//
// This makes NO access decision: the middleware is still the single source of authorization, exactly as when
// each service was written by hand. `assertNotLocked` is a workflow precondition, not access control.
import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import { assertNotLocked } from "./lifecycle";

// Drizzle tables are heavily generic; treated structurally here, as in services/softDelete.ts.
type Table = any;
type Row = {
  uuid: string;
  code: string | null;
  createdAt: Date | number;
  updatedAt: Date | number;
  deleteTime?: Date | number | null;
  locked?: boolean | null;
  [k: string]: unknown;
};

export type CrudSpec<I> = {
  table: Table;
  /** Wire collection (`pay-grades`) - the audit entity and the access-hint key. */
  collection: string;
  /** Audit action stem and the `<name> not found` text the shared soft-delete helpers raise (`pay_grade`). */
  auditName: string;
  /** 404 detail for get/update, phrased for a human (`pay grade not found`). */
  notFound: string;
  /** Wire input -> insert columns. Throws `invalidArgument` for a missing/unparseable required field. */
  insert: (input: I, deps: Deps, actor: AppUser) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Wire patch -> the `set` object: ONLY keys the caller actually sent (see `has`), so a diff stays honest.
   * Async when a field has to be resolved against another table (a reference the write must validate).
   */
  patch: (input: I, row: any, deps: Deps) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Presentation order within a page. Default: oldest-first by (createTime, uuid), the cursor's own order. */
  sort?: (a: any, b: any) => number;
  /** Per-caller decoration of the returned rows (e.g. a holiday's own selection). Runs on the page, not the table. */
  decorate?: (deps: Deps, actor: AppUser, rows: any[]) => Promise<any[]>;
  /** Side effects the write owes the rest of the system (notify, re-accrue, emit an event). Run after the audit row. */
  afterCreate?: (deps: Deps, actor: AppUser, row: any, input: I) => Promise<void>;
  afterUpdate?: (deps: Deps, actor: AppUser, row: any, before: any, patch: I) => Promise<void>;
  /**
   * Code allocation, when the resource is not a flat one (owned/dept-scoped tables). Receives the resolved
   * insert values, since an owned code is allocated under the row's owner.
   */
  allocCode?: (deps: Deps, table: Table, values: Record<string, unknown>) => Promise<string>;
};

export type CrudService<I> = {
  list: (deps: Deps, actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted?: boolean) => Promise<{ items: any[]; nextPageToken?: string }>;
  get: (deps: Deps, actor: AppUser, id: string) => Promise<any>;
  create: (deps: Deps, actor: AppUser, input: I, id?: string) => Promise<any>;
  update: (deps: Deps, actor: AppUser, id: string, patch: I, ifMatch?: string) => Promise<any>;
  remove: (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => Promise<void>;
  restore: (deps: Deps, actor: AppUser, id: string) => Promise<any>;
  purge: (deps: Deps, actor: AppUser, id: string, ifMatch?: string) => Promise<void>;
};

/** Did the caller actually send this key? A PATCH of `{x: undefined}` clears x; an absent x leaves it alone. */
export const has = <T extends object>(patch: T, key: keyof T) => Object.prototype.hasOwnProperty.call(patch, key);

const byCreated = (a: Row, b: Row) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid);

export function crudService<I>(spec: CrudSpec<I>): CrudService<I> {
  const { table, collection, auditName } = spec;
  // allocFlatCode's third parameter is a width, not the values bag - bind it explicitly.
  const alloc = spec.allocCode ?? ((deps: Deps, t: Table) => allocFlatCode(deps, t));

  const required = async (deps: Deps, id: string): Promise<Row> => {
    const row = (await deps.db.select().from(table).where(eq(table.uuid, id)).limit(1))[0] as Row | undefined;
    if (!row) throw notFound(spec.notFound);
    return row;
  };
  const decorate = async (deps: Deps, actor: AppUser, rows: any[]) => (spec.decorate ? spec.decorate(deps, actor, rows) : rows);

  return {
    async list(deps, actor, maxPageSize, pageToken, showDeleted = false) {
      const all = visibleByDelete((await deps.db.select().from(table)) as Row[], showDeleted).sort(spec.sort ?? byCreated);
      // The cursor is keyed on (createTime, uuid) whatever `sort` presents, so a page boundary stays stable
      // while rows are inserted. Paging is in-memory over the whole table: bounded by clampPageSize upstream
      // and by the 100-row cap the truncation contract pins (test/listTruncation.test.ts).
      const cur = decodeCursor(pageToken);
      const start = cur
        ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
        : 0;
      const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
      const last = slice[slice.length - 1];
      const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
      return { items: await decorate(deps, actor, slice), nextPageToken };
    },

    async get(deps, actor, id) {
      return (await decorate(deps, actor, [await required(deps, id)]))[0];
    },

    async create(deps, actor, input, id) {
      const values = await spec.insert(input, deps, actor);
      const row = ((await deps.db
        .insert(table)
        .values({ code: await alloc(deps, table, values), ...(id ? { uuid: id } : {}), ...values })
        .returning()) as Row[])[0]!;
      await audit(deps, actor, `${auditName}.create`, collection, row.uuid, undefined, row);
      if (spec.afterCreate) await spec.afterCreate(deps, actor, row, input);
      return row;
    },

    async update(deps, actor, id, patch, ifMatch) {
      const row = await required(deps, id);
      // A row in the trash is not editable: restore it first. (A GET still resolves it, so `?show_deleted`
      // views and audit links keep working.)
      if (row.deleteTime) throw notFound(spec.notFound);
      assertNotLocked(row);
      if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
      const set: Record<string, unknown> = { updatedAt: new Date(), ...(await spec.patch(patch, row, deps)) };
      const updated = ((await deps.db.update(table).set(set).where(eq(table.uuid, id)).returning()) as Row[])[0]!;
      await audit(deps, actor, `${auditName}.update`, collection, id, diffMeta(row, updated, set), updated);
      if (spec.afterUpdate) await spec.afterUpdate(deps, actor, updated, row, patch);
      return updated;
    },

    remove: (deps, actor, id, ifMatch) => softDeleteRow(deps, actor, table, auditName, collection, id, ifMatch),
    restore: (deps, actor, id) => restoreRow(deps, actor, table, auditName, collection, id),
    purge: (deps, actor, id, ifMatch) => purgeRow(deps, actor, table, auditName, collection, id, ifMatch),
  };
}
