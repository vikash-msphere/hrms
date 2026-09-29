// Who may see, work and manage one board, kept as ACL data (no engine change) - the same approach as ticket
// servicing departments (services/ticketShares.ts).
//
// A board's access comes from three places, and this file turns the last two into rules:
//
//   1. Its VISIBILITY, which is its code segment (domain/boardAccess.ts): the seeded employee rules reach every
//      `ve-` and `vr-` board by subtree, so an org-visible board needs no rule of its own.
//   2. Its SHARING LIST (`boards.shares_json`): people and roles at view / edit / manage. The board's creator
//      is put on it at manage when the board is made, and can be taken off like anyone else.
//   3. Its DEPARTMENT: the managers listed on that department and on every department above it manage it.
//
// `syncBoardShares` computes the rules those two sources amount to and makes the stored `board-share` rows
// match - inserting what is missing, deleting what is no longer wanted, and touching nothing else. Every row
// it writes is marked `source: "board-share"` and every row it deletes is matched on that mark, so a rule an
// admin authored on the same board in Access Management is never removed by a resync. It runs whenever an
// input moves: the board's list or department changes, or a department's managers or parent change.
//
// The rules are SUBTREE rules on the board's code (`cards.ve-0a-*.**`), which the engine treats as broad rules:
// they sit in the holder's cached grant, reach the board's cards and sprints through their codes, and are seen
// by the list, its access hints and the create gate alike.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import {
  BOARD_LEVELS, BOARD_LEVEL_RANK, BOARD_NAMESPACES, VISIBILITY_SEG, boardLevelRules, visibilityOfCode,
  type BoardLevel, type BoardMember, type BoardVisibility,
} from "../domain/boardAccess";
import { deriveNarrowing } from "../domain/compileGrants";
import { holdsEveryObject } from "../lib/objectAccess";
import { audit } from "../lib/audit";
import { clearCachePrefix } from "../lib/cache";
import { byIdChunks, chunk, ID_CHUNK, insertBatches, runBatch, type BatchStmt } from "../lib/dbBatch";
import { forbidden, invalidArgument, isCodeCollision } from "../lib/errors";
import { invalidateCodeCache } from "../lib/authzResolve";
import { allocUnderPrefix, withFreshCode } from "./codeAlloc";
import { reprefixPattern } from "./codeCascade";
import { usersForEmployees } from "./ticketShares";

/** A stored sharing list, tolerant of a malformed column (an empty list, never a throw on read). */
export function parseMembers(json: string | null | undefined): BoardMember[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? normalizeMembers(v, false) : [];
  } catch {
    return [];
  }
}

/**
 * A sharing list as the API sends it, validated and de-duplicated (one entry per subject, at the highest level
 * named). `strict` refuses a malformed entry rather than dropping it: a client that sends a typo must be told.
 */
export function normalizeMembers(input: unknown, strict = true): BoardMember[] {
  if (!Array.isArray(input)) {
    if (strict) throw invalidArgument("members must be a list");
    return [];
  }
  const out = new Map<string, BoardMember>();
  for (const raw of input) {
    const m = raw as Partial<BoardMember> | null;
    const ok = m && (m.kind === "user" || m.kind === "role") && typeof m.subject === "string" && m.subject.length > 0 && BOARD_LEVELS.includes(m.level as BoardLevel);
    if (!ok) {
      if (strict) throw invalidArgument("each member needs kind (user or role), subject and level (view, edit or manage)");
      continue;
    }
    // A person arrives as a `users/<id>` ref (kept as the bare id, which is what a rule's subject is) or as an
    // `employees/<id>` ref, which `resolveMemberAccounts` turns into their account. The inbound edge has already
    // decoded either to the internal id.
    const subject = m.kind === "user" && m.subject!.startsWith("users/") ? m.subject!.slice("users/".length) : m.subject!;
    const key = `${m.kind}|${subject}`;
    const held = out.get(key);
    if (!held || BOARD_LEVEL_RANK[m.level as BoardLevel] > BOARD_LEVEL_RANK[held.level]) out.set(key, { kind: m.kind!, subject, level: m.level as BoardLevel });
  }
  return [...out.values()];
}

/**
 * A person named by their employee record (`employees/<id>`, what the people picker holds) becomes their
 * account, since a rule's subject is an account. Someone with no sign-in account cannot be given a board.
 */
export async function resolveMemberAccounts(deps: Deps, members: BoardMember[]): Promise<BoardMember[]> {
  const byEmployee = members.filter((m) => m.kind === "user" && m.subject.startsWith("employees/")).map((m) => m.subject.slice("employees/".length));
  if (!byEmployee.length) return members;
  const rows = await byIdChunks(byEmployee, (group) =>
    deps.db.select({ uuid: schema.users.uuid, employeeId: schema.users.employeeId }).from(schema.users).where(inArray(schema.users.employeeId, group)),
  );
  const account = new Map(rows.map((r) => [r.employeeId, r.uuid]));
  const out = members.map((m) => {
    if (m.kind !== "user" || !m.subject.startsWith("employees/")) return m;
    const uuid = account.get(m.subject.slice("employees/".length));
    if (!uuid) throw invalidArgument("a member has no sign-in account, so a board cannot be shared with them");
    return { ...m, subject: uuid };
  });
  return normalizeMembers(out, false);
}

// ---- Departments -----------------------------------------------------------------------------------------------

type DeptRow = { uuid: string; code: string | null; parentId: string | null; managerIds: string | null; deleteTime: Date | null };

// The department table is small and every question here walks it, so it is read whole, once per call.
const loadDepartments = async (deps: Deps): Promise<DeptRow[]> =>
  deps.db.select({ uuid: schema.departments.uuid, code: schema.departments.code, parentId: schema.departments.parentId, managerIds: schema.departments.managerIds, deleteTime: schema.departments.deleteTime }).from(schema.departments);

const managersOf = (d: DeptRow): string[] => {
  try {
    const v = JSON.parse(d.managerIds ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** A department and every department above it, nearest first. Bounded, so a corrupt cycle cannot spin. */
function chainOf(depts: DeptRow[], departmentId: string | null): DeptRow[] {
  const byId = new Map(depts.map((d) => [d.uuid, d]));
  const out: DeptRow[] = [];
  let at = departmentId ? byId.get(departmentId) : undefined;
  for (let i = 0; at && i < 64; i++) {
    out.push(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return out;
}

/** The user accounts of whoever manages boards filed under `departmentId`: its managers and its ancestors'. */
export async function departmentManagerUsers(deps: Deps, departmentId: string | null, depts?: DeptRow[]): Promise<string[]> {
  if (!departmentId) return [];
  const chain = chainOf(depts ?? (await loadDepartments(deps)), departmentId).filter((d) => !d.deleteTime);
  return usersForEmployees(deps, chain.flatMap(managersOf));
}

/** The departments the caller manages, and every department below them - the ones they may file a board under. */
async function managedDepartments(deps: Deps, actor: AppUser): Promise<Set<string>> {
  const out = new Set<string>();
  if (!actor.employeeId) return out;
  const depts = await loadDepartments(deps);
  const heads = depts.filter((d) => !d.deleteTime && d.code && managersOf(d).includes(actor.employeeId!));
  for (const d of depts) {
    if (d.deleteTime || !d.code) continue;
    if (heads.some((h) => d.code === h.code || d.code!.startsWith(`${h.code}-`))) out.add(d.uuid);
  }
  return out;
}

/**
 * Does the caller manage EVERY board (super admin, the project manager)? Asked of a wildcard key: only a
 * wildcard pattern matches the token `*`, so no board share - which names one board's code - can answer yes.
 */
export function managesEveryBoard(actor: AppUser): boolean {
  return holdsEveryObject(actor, "boards", "write");
}

/**
 * May the caller file a board under `departmentId`? Whoever manages every board may file it anywhere, or
 * nowhere. Anyone else may only name a department they (or a department above it) manage - filing a board
 * under somebody else's department would hand it to that department's managers - and must name one when they
 * manage any (`required`), so a manager's board is never left outside their department.
 */
export async function assertMayFileUnder(deps: Deps, actor: AppUser, departmentId: string | null, required: boolean): Promise<void> {
  if (departmentId) {
    const exists = (await deps.db.select({ uuid: schema.departments.uuid }).from(schema.departments).where(eq(schema.departments.uuid, departmentId)).limit(1))[0];
    if (!exists) throw invalidArgument("department not found");
  }
  if (managesEveryBoard(actor)) return;
  const managed = await managedDepartments(deps, actor);
  if (departmentId && !managed.has(departmentId)) throw forbidden("a board can only be filed under a department you manage");
  if (!departmentId && required && managed.size) throw invalidArgument("department is required: choose one of the departments you manage");
}

// ---- The rules -------------------------------------------------------------------------------------------------

type Wanted = { kind: "user" | "role"; subject: string; level: BoardLevel };

/** Who holds what on the board: the sharing list, raised to manage for the department's managers. */
export async function wantedAccess(deps: Deps, board: { sharesJson: string; departmentId: string | null }, depts?: DeptRow[]): Promise<Wanted[]> {
  const out = new Map<string, Wanted>();
  const put = (w: Wanted) => {
    const key = `${w.kind}|${w.subject}`;
    const held = out.get(key);
    if (!held || BOARD_LEVEL_RANK[w.level] > BOARD_LEVEL_RANK[held.level]) out.set(key, w);
  };
  for (const m of parseMembers(board.sharesJson)) put(m);
  for (const u of await departmentManagerUsers(deps, board.departmentId, depts)) put({ kind: "user", subject: u, level: "manage" });
  return [...out.values()];
}

const ruleKey = (r: { subject: string; subjectKind: string; pattern: string; level: string | null }) => `${r.subjectKind}|${r.subject}|${r.pattern}|${r.level ?? ""}`;

function rowsFor(boardCode: string, w: Wanted) {
  return boardLevelRules(boardCode, w.level).map((r) => {
    const n = deriveNarrowing(r.pattern);
    return {
      subject: w.subject,
      subjectKind: w.kind,
      namespace: n.namespace,
      pattern: r.pattern,
      scopeKind: n.scopeKind,
      scopeCode: n.scopeCode,
      matchCode: null,
      level: r.level,
      effect: "allow" as const,
      source: "board-share" as const,
    };
  });
}

// Every `board-share` row on one board: they all carry the board's code as their subtree scope.
const ownRows = (deps: Deps, boardCode: string) =>
  deps.db
    .select({ uuid: schema.accessRules.uuid, subject: schema.accessRules.subject, subjectKind: schema.accessRules.subjectKind, pattern: schema.accessRules.pattern, level: schema.accessRules.level })
    .from(schema.accessRules)
    .where(and(
      eq(schema.accessRules.source, "board-share"),
      inArray(schema.accessRules.namespace, [...BOARD_NAMESPACES]),
      eq(schema.accessRules.scopeCode, boardCode),
    ));

// The rows just written or removed ARE compiled grants, cached per role, per user and per caller
// (lib/policyLoad.ts): drop them here so this isolate decides from the new rows at once. Others follow the
// counters the access_rules triggers move.
function dropGrantCaches() {
  clearCachePrefix("grant:");
  clearCachePrefix("userGrant:");
  clearCachePrefix("objRules:");
}

/** Make the board's stored `board-share` rows match what its sharing list and department amount to. */
export async function syncBoardShares(deps: Deps, actor: AppUser, boardId: string, depts?: DeptRow[]): Promise<void> {
  const board = (await deps.db.select().from(schema.boards).where(eq(schema.boards.uuid, boardId)).limit(1))[0];
  if (!board?.code) return;
  const wanted = (await wantedAccess(deps, board, depts)).flatMap((w) => rowsFor(board.code!, w));
  const have = await ownRows(deps, board.code);
  const wantKeys = new Set(wanted.map(ruleKey));
  const haveKeys = new Set(have.map(ruleKey));
  const stale = have.filter((r) => !wantKeys.has(ruleKey(r))).map((r) => r.uuid);
  const missing = wanted.filter((r) => !haveKeys.has(ruleKey(r)));
  if (!stale.length && !missing.length) return;
  const stmts: BatchStmt[] = [
    ...chunk(stale, ID_CHUNK).map((group) => deps.db.delete(schema.accessRules).where(inArray(schema.accessRules.uuid, group))),
    ...insertBatches(missing, (group) => deps.db.insert(schema.accessRules).values(group)),
  ];
  await runBatch(deps.db, stmts);
  // One entry per sync: the question the trail answers is "when did this board's access change", one event.
  await audit(deps, actor, "board.share.sync", "boards", board.uuid, { added: missing.length, removed: stale.length, source: "board-share" });
  dropGrantCaches();
}

/** Resync every live board filed under one of `departmentIds` - after their managers or their place moved. */
export async function syncBoardsUnder(deps: Deps, actor: AppUser, departmentIds: string[]): Promise<void> {
  if (!departmentIds.length) return;
  const rows = await byIdChunks(departmentIds, (group) =>
    deps.db.select({ uuid: schema.boards.uuid }).from(schema.boards).where(inArray(schema.boards.departmentId, group)),
  );
  if (!rows.length) return;
  const depts = await loadDepartments(deps);
  for (const r of rows) await syncBoardShares(deps, actor, r.uuid, depts);
}

/** A department and every department below it (by code), for a change that reaches the whole subtree. */
export async function departmentSubtree(deps: Deps, departmentId: string): Promise<string[]> {
  const depts = await loadDepartments(deps);
  const root = depts.find((d) => d.uuid === departmentId);
  if (!root?.code) return [departmentId];
  return depts.filter((d) => d.code && (d.code === root.code || d.code.startsWith(`${root.code}-`))).map((d) => d.uuid);
}

// ---- Visibility ------------------------------------------------------------------------------------------------

/**
 * Move a board to another visibility, which is another code segment: the board, its cards, its sprints and every
 * rule naming any of them are re-coded in ONE batch, so no request ever sees the board under one code and its
 * cards under the other. The uuid (and the wire id) is unchanged. Returns the board's code afterwards.
 */
export async function recodeBoard(deps: Deps, board: { uuid: string; code: string | null }, visibility: BoardVisibility): Promise<string> {
  const oldCode = board.code;
  if (!oldCode) throw invalidArgument("board has no code");
  if (visibilityOfCode(oldCode) === visibility) return oldCode;
  const under = (c: any) => or(eq(c, oldCode), sql`${c} glob ${`${oldCode}-*`}`);
  const from = oldCode.length + 1;
  const newCode = await withFreshCode(async (attempt) => {
    const next = await allocUnderPrefix(deps, schema.boards, VISIBILITY_SEG[visibility], undefined, attempt > 1);
    const ns = inArray(schema.accessRules.namespace, [...BOARD_NAMESPACES]);
    const rules = await deps.db
      .select({ uuid: schema.accessRules.uuid, pattern: schema.accessRules.pattern })
      .from(schema.accessRules)
      .where(and(ns, inArray(schema.accessRules.scopeKind, ["exact", "subtree"]), or(under(schema.accessRules.matchCode), under(schema.accessRules.scopeCode))));
    const stmts: BatchStmt[] = [
      deps.db.update(schema.boards).set({ code: next, updatedAt: new Date() }).where(eq(schema.boards.uuid, board.uuid)),
      deps.db.update(schema.cards).set({ code: sql`${next} || substr(${schema.cards.code}, ${from})` }).where(and(eq(schema.cards.boardId, board.uuid), under(schema.cards.code))),
      deps.db.update(schema.sprints).set({ code: sql`${next} || substr(${schema.sprints.code}, ${from})` }).where(and(eq(schema.sprints.boardId, board.uuid), under(schema.sprints.code))),
      deps.db.update(schema.accessRules).set({ matchCode: sql`${next} || substr(${schema.accessRules.matchCode}, ${from})`, updatedAt: new Date() }).where(and(ns, under(schema.accessRules.matchCode))),
      deps.db.update(schema.accessRules).set({ scopeCode: sql`${next} || substr(${schema.accessRules.scopeCode}, ${from})`, updatedAt: new Date() }).where(and(ns, under(schema.accessRules.scopeCode))),
    ];
    for (const r of rules) {
      const pattern = reprefixPattern(r.pattern, oldCode, next);
      if (pattern) stmts.push(deps.db.update(schema.accessRules).set({ pattern, updatedAt: new Date() }).where(eq(schema.accessRules.uuid, r.uuid)));
    }
    await runBatch(deps.db, stmts);
    return next;
  }, isCodeCollision);
  invalidateCodeCache();
  dropGrantCaches();
  return newCode;
}
