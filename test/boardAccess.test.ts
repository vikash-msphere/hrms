/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings, AppUser } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { clearCache } from "../src/lib/cache";
import { insertBatches, runBatch } from "../src/lib/dbBatch";
import { loadRoleGrant, loadUserGrant } from "../src/lib/policyLoad";
import { compileGrant, deriveNarrowing, mergeGrants } from "../src/domain/compileGrants";
import { decide, resolveRequest } from "../src/domain/permissions";
import { grantFor, EVERYONE_GRANT } from "../bootstrap/authz/grants";
import { createBoard, shareBoard, updateBoard } from "../src/services/boards";
import { createCard } from "../src/services/cards";
import { createSprint } from "../src/services/sprints";
import { updateDepartment } from "../src/services/departments";
import { syncBoardShares } from "../src/services/boardShares";
import { seedManifest } from "./seedManifest";
import { app } from "../src/index";

// Board access, decided the way a request is: the caller's role grant and their own rules as stored in
// `access_rules`, after the service wrote them. A board's visibility is its code segment, its cards and sprints
// are coded under it, and its creator, its sharing list and its department's managers (up the tree) are
// `board-share` rules services/boardShares.ts keeps in step (domain/boardAccess.ts).
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const DEV_EMAIL = "dev@example.com"; // the ambient dev-auth caller (vitest.config.ts DEV_FAKE_EMAIL)
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run();
  }
  await seedManifest(b.DB);
  deps = makeDeps(b);
});

const TABLES = [schema.cardMovements, schema.cardWatchers, schema.cards, schema.sprints, schema.boards, schema.accessRules, schema.notifications, schema.auditLog, schema.eventLog, schema.users, schema.employees, schema.departments, schema.roles, schema.codeSequences];
const ROLES = ["employee", "manager", "hr_admin", "project_manager"] as const;
type Role = (typeof ROLES)[number];

let seq = 0;
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  clearCache();
  // The seeded roles' compiled rules, as the bootstrap writes them - the board rules under test live beside them.
  await deps.db.insert(schema.roles).values(ROLES.map((name) => ({ name, label: name })));
  const rows = [
    ...ROLES.flatMap((role) => compileGrant(grantFor(role)).map((r) => ({ ...r, subject: role }))),
    ...compileGrant(EVERYONE_GRANT).map((r) => ({ ...r, subject: "everyone" })),
  ].map((r) => ({ ...r, uuid: genId(), subjectKind: "role" as const }));
  await runBatch(deps.db, insertBatches(rows, (group) => deps.db.insert(schema.accessRules).values(group)));
});

async function department(code: string, managers: string[] = [], parentId: string | null = null) {
  const uuid = genId();
  await deps.db.insert(schema.departments).values({ uuid, code, name: `Dept ${code}`, parentId, managerIds: JSON.stringify(managers) });
  return uuid;
}

// A person: an employee in `deptCode`, and an account holding `role`.
async function person(role: Role, deptCode: string, email = `${genId()}@t.example`) {
  const employeeId = genId();
  const code = `${deptCode}-${(++seq).toString(32).padStart(3, "0")}`;
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code, firstName: role, lastName: `P${seq}`, workEmail: email, status: "active" });
  const uuid = genId();
  await deps.db.insert(schema.users).values({ uuid, code: `u-${seq}`, email, role, employeeId });
  return { uuid, role, employeeId, employeeCode: code, email };
}
type Person = Awaited<ReturnType<typeof person>>;

// The caller as the auth middleware assembles them: role grant + their own rules, read fresh from the rows.
async function actor(p: Person): Promise<AppUser> {
  clearCache();
  const grant = mergeGrants(await loadRoleGrant(deps, p.role), await loadUserGrant(deps, p.uuid));
  return { uuid: p.uuid, email: p.email, role: p.role, status: "active", employeeId: p.employeeId, employeeCode: p.employeeCode, grant, self: { employeeCode: p.employeeCode } } as unknown as AppUser;
}
async function may(p: Person, method: string, path: string) {
  return decide((await actor(p)).grant, resolveRequest(method, path, false), { employeeCode: p.employeeCode }).allow;
}
const codeOf = async (table: typeof schema.boards | typeof schema.cards | typeof schema.sprints, uuid: string) =>
  (await deps.db.select({ code: table.code }).from(table).where(eq(table.uuid, uuid)).limit(1))[0]!.code!;

describe("a board's department", () => {
  it("its managers, and the managers of every department above it, manage the board - nobody else by role", async () => {
    const parentHead = await person("manager", "04");
    const childHead = await person("manager", "04-01");
    const salesHead = await person("manager", "07");
    const hr = await person("hr_admin", "06");
    const pm = await person("project_manager", "02");
    const parent = await department("04", [parentHead.employeeId]);
    const child = await department("04-01", [childHead.employeeId], parent);
    await department("07", [salesHead.employeeId]);

    const board = await createBoard(deps, await actor(pm), { name: "Platform", department: `departments/${child}`, visibility: "private" });
    expect(board.code).toMatch(/^vp-/);
    for (const [who, expected] of [[childHead, true], [parentHead, true], [salesHead, false], [hr, false], [pm, true]] as const) {
      expect(await may(who, "PATCH", `/v1/boards/${board.code}`), `${who.role} ${who.employeeCode}`).toBe(expected);
      expect(await may(who, "GET", `/v1/boards/${board.code}`), `${who.role} ${who.employeeCode} read`).toBe(expected);
    }
  });

  it("a manager must file their board under a department they manage", async () => {
    const head = await person("manager", "04");
    const salesHead = await person("manager", "07");
    const mine = await department("04", [head.employeeId]);
    const sales = await department("07", [salesHead.employeeId]);
    await expect(createBoard(deps, await actor(head), { name: "Nowhere" })).rejects.toThrow(/department is required/);
    await expect(createBoard(deps, await actor(head), { name: "Theirs", department: `departments/${sales}` })).rejects.toThrow(/department you manage/);
    const board = await createBoard(deps, await actor(head), { name: "Mine", department: `departments/${mine}` });
    expect(board.departmentId).toBe(mine);
  });

  it("HR, which manages no department, files a board under none and manages it as its creator", async () => {
    const hr = await person("hr_admin", "06");
    const colleague = await person("employee", "06");
    const board = await createBoard(deps, await actor(hr), { name: "People ops", visibility: "private" });
    expect(await may(hr, "POST", `/v1/boards/${board.code}:configure`)).toBe(true);
    expect(await may(colleague, "GET", `/v1/boards/${board.code}`)).toBe(false);
  });

  it("follows the department: new managers gain the board, removed ones lose it, a re-parent moves it", async () => {
    const pm = await person("project_manager", "02");
    const parentHead = await person("manager", "04");
    const childHead = await person("manager", "04-01");
    const salesHead = await person("manager", "07");
    const parent = await department("04", [parentHead.employeeId]);
    const child = await department("04-01", [childHead.employeeId], parent);
    const sales = await department("07", [salesHead.employeeId]);
    const board = await createBoard(deps, await actor(pm), { name: "Platform", department: `departments/${child}`, visibility: "private" });
    const path = `/v1/boards/${board.code}`;

    await updateDepartment(deps, await actor(pm), child, { managers: [] });
    expect(await may(childHead, "PATCH", path)).toBe(false);
    expect(await may(parentHead, "PATCH", path)).toBe(true); // still above it

    await updateDepartment(deps, await actor(pm), child, { parent: `departments/${sales}` });
    expect(await may(parentHead, "PATCH", path)).toBe(false);
    expect(await may(salesHead, "PATCH", path)).toBe(true);

    await updateBoard(deps, await actor(pm), board.uuid, { department: null });
    expect(await may(salesHead, "PATCH", path)).toBe(false);
  });
});

describe("a board's visibility and sharing", () => {
  it("a private board's list decides who views, edits and manages it - and its tasks and sprints follow", async () => {
    const pm = await person("project_manager", "02");
    const viewer = await person("employee", "04");
    const editor = await person("employee", "04");
    const outsider = await person("employee", "04");
    const board = await createBoard(deps, await actor(pm), { name: "Secret", visibility: "private", mode: "scrum" });
    const card = await createCard(deps, await actor(pm), { title: "Task", board: `boards/${board.uuid}` });
    const sprint = await createSprint(deps, await actor(pm), { name: "S1", board: `boards/${board.uuid}` });
    expect(card.code!.startsWith(`${board.code}-`)).toBe(true);
    expect(sprint.code!.startsWith(`${board.code}-`)).toBe(true);

    await shareBoard(deps, await actor(pm), board.uuid, { members: [
      { kind: "user", subject: `users/${viewer.uuid}`, level: "view" },
      { kind: "user", subject: `users/${editor.uuid}`, level: "edit" },
    ] });
    const cardPath = `/v1/cards/${card.code}`;
    expect(await may(viewer, "GET", cardPath)).toBe(true);
    expect(await may(viewer, "GET", `/v1/sprints/${sprint.code}`)).toBe(true);
    expect(await may(viewer, "POST", `${cardPath}:move`)).toBe(false);
    expect(await may(editor, "POST", `${cardPath}:move`)).toBe(true);
    expect(await may(editor, "PATCH", cardPath)).toBe(true);
    expect(await may(editor, "PATCH", `/v1/boards/${board.code}`)).toBe(false);
    expect(await may(editor, "POST", `/v1/sprints/${sprint.code}:activate`)).toBe(false);
    for (const p of [`/v1/boards/${board.code}`, cardPath, `/v1/sprints/${sprint.code}`]) expect(await may(outsider, "GET", p), p).toBe(false);

    // Taken off the list, they lose it on the next decision.
    await shareBoard(deps, await actor(pm), board.uuid, { members: [] });
    expect(await may(editor, "GET", cardPath)).toBe(false);
  });

  it("changing visibility re-codes the board, its cards, its sprints and the rules on them in one move", async () => {
    const pm = await person("project_manager", "02");
    const editor = await person("employee", "04");
    const outsider = await person("employee", "04");
    const board = await createBoard(deps, await actor(pm), { name: "Opening up", visibility: "private" });
    const card = await createCard(deps, await actor(pm), { title: "Task", board: `boards/${board.uuid}` });
    await shareBoard(deps, await actor(pm), board.uuid, { members: [{ kind: "user", subject: `users/${editor.uuid}`, level: "edit" }] });

    await shareBoard(deps, await actor(pm), board.uuid, { visibility: "view" });
    const boardCode = await codeOf(schema.boards, board.uuid);
    const cardCode = await codeOf(schema.cards, card.uuid);
    expect(boardCode).toMatch(/^vr-/);
    expect(cardCode.startsWith(`${boardCode}-`)).toBe(true);
    // Everyone sees it now; only the list works it - and the editor's rules moved with the code.
    expect(await may(outsider, "GET", `/v1/cards/${cardCode}`)).toBe(true);
    expect(await may(outsider, "POST", `/v1/cards/${cardCode}:move`)).toBe(false);
    expect(await may(editor, "POST", `/v1/cards/${cardCode}:move`)).toBe(true);

    await shareBoard(deps, await actor(pm), board.uuid, { visibility: "edit" });
    const openCard = await codeOf(schema.cards, card.uuid);
    expect(openCard).toMatch(/^ve-/);
    expect(await may(outsider, "POST", `/v1/cards/${openCard}:move`)).toBe(true);
  });

  it("a resync removes only its own rows - a rule an admin authored on the board survives", async () => {
    const pm = await person("project_manager", "02");
    const someone = await person("employee", "04");
    const board = await createBoard(deps, await actor(pm), { name: "Authored", visibility: "private" });
    const pattern = `boards.${board.code}.**`;
    const n = deriveNarrowing(pattern);
    await deps.db.insert(schema.accessRules).values({ subject: someone.uuid, subjectKind: "user", namespace: n.namespace, pattern, scopeKind: n.scopeKind, scopeCode: n.scopeCode, matchCode: n.scopeCode, level: "read", effect: "allow", source: "acl" });
    await shareBoard(deps, await actor(pm), board.uuid, { members: [] });
    await syncBoardShares(deps, await actor(pm), board.uuid);
    const kept = await deps.db.select().from(schema.accessRules).where(and(eq(schema.accessRules.subject, someone.uuid), eq(schema.accessRules.pattern, pattern)));
    expect(kept).toHaveLength(1);
  });

  it("a person may be named by their employee record (what the people picker holds); the rule goes to their account", async () => {
    const pm = await person("project_manager", "02");
    const someone = await person("employee", "04");
    const board = await createBoard(deps, await actor(pm), { name: "Picked", visibility: "private" });
    await shareBoard(deps, await actor(pm), board.uuid, { members: [{ kind: "user", subject: `employees/${someone.employeeId}`, level: "view" }] });
    expect(await may(someone, "GET", `/v1/boards/${board.code}`)).toBe(true);
    const stored = (await deps.db.select({ shares: schema.boards.sharesJson }).from(schema.boards).where(eq(schema.boards.uuid, board.uuid)))[0]!.shares;
    expect(JSON.parse(stored)).toContainEqual({ kind: "user", subject: someone.uuid, level: "view" });
  });

  it("a member must be a real account or role", async () => {
    const pm = await person("project_manager", "02");
    const board = await createBoard(deps, await actor(pm), { name: "Typo" });
    await expect(shareBoard(deps, await actor(pm), board.uuid, { members: [{ kind: "role", subject: "no_such_role", level: "view" }] })).rejects.toThrow(/role that does not exist/);
    await expect(shareBoard(deps, await actor(pm), board.uuid, { members: [{ kind: "user", subject: `users/${genId()}`, level: "view" }] })).rejects.toThrow(/user that does not exist/);
  });
});

// The create gate is the middleware's (policy owner_refs `cards.board`): the 1-token `cards` create grant cannot
// see which board, so it is asked through the app, as the ambient dev caller.
describe("filing a task needs write on the board's tasks", () => {
  it("a viewer is refused, an editor files it", async () => {
    const pm = await person("project_manager", "02");
    const me = await person("employee", "04", DEV_EMAIL);
    const board = await createBoard(deps, await actor(pm), { name: "Gate", visibility: "private" });
    const file = () => app.request("/v1/cards", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Requested-By": "hrms-spa" },
      body: JSON.stringify({ title: "From the gate", board: `boards/${board.uuid}` }),
    }, b as unknown as Record<string, unknown>);

    await shareBoard(deps, await actor(pm), board.uuid, { members: [{ kind: "user", subject: `users/${me.uuid}`, level: "view" }] });
    clearCache();
    expect((await file()).status).toBe(403);
    await shareBoard(deps, await actor(pm), board.uuid, { members: [{ kind: "user", subject: `users/${me.uuid}`, level: "edit" }] });
    clearCache();
    const ok = await file();
    expect(ok.status, await ok.clone().text()).toBe(200);
  });
});
