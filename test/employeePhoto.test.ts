/// <reference types="vite/client" />
/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
const migrationModules = import.meta.glob("../src/db/migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const migrationSql = Object.keys(migrationModules).sort().map((k) => migrationModules[k]).join("\n");
import * as schema from "../src/db/schema";
import type { Bindings } from "../src/env";
import { makeDeps, type Deps } from "../src/deps";
import { genId } from "../src/lib/idCodec";
import { clearCache } from "../src/lib/cache";
import { systemActor } from "../src/lib/systemActor";
import { uploadPhoto } from "../src/services/employeePhoto";
import { app } from "../src/index";

// THE FACE IS PART OF THE RECORD. Every avatar in the app is an `<img>` pointed at
// `GET /v1/employees/<id>:getPhoto?v=<version>`, and what decides whether the bytes come back is the single
// question "may this caller read this employee?" - the same verdict the row's own GET gives
// (services/employeePhoto.ts#photoRef). Holding the verb is not the permission; it is only the transport, which
// is why every caller below holds it and they still do not all get an answer.
//
// The rest is what makes one request per face affordable: an image content type (the app sends `nosniff`, so a
// body typed as bytes never paints), a versioned URL the browser may keep for a week, and a revalidation that
// re-runs the access check and sends nothing back.
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 7, 7, 7, 7]);
let deps: Deps;
const b = env as unknown as Bindings;

beforeAll(async () => {
  (b as Record<string, unknown>).FIELD_ENCRYPTION_KEY = KEY;
  (b as Record<string, unknown>).WIRE_ID_KEY = KEY;
  (b as Record<string, unknown>).ALLOW_DEV_AUTH = "true";
  for (const stmt of migrationSql.split("--> statement-breakpoint")) {
    const s = stmt.trim();
    if (s) await b.DB.prepare(s).run().catch(() => {}); // tables may already exist from another suite
  }
  deps = makeDeps(b);
});

const TABLES = [schema.accessRules, schema.auditLog, schema.users, schema.employees, schema.roles];
beforeEach(async () => {
  for (const t of TABLES) await deps.db.delete(t);
  await deps.db.insert(schema.roles).values([
    { name: "employee", label: "Employee" },
    { name: "hr_admin", label: "HR" },
  ]);
  // The seeded shape, reduced to what this is about: everybody may fetch a photo (transport), an employee may
  // read their OWN record, and HR may read everyone's. Nobody is granted "see colleague X's face" directly -
  // that is derived from the read, which is the whole point.
  await deps.db.insert(schema.accessRules).values([
    rule("employee", "employees.*.getPhoto", { level: null }),
    rule("hr_admin", "employees.*.getPhoto", { level: null }),
    rule("employee", "employees.me.**", { level: "read", scopeKind: "self" }),
    rule("employee", "users.me.**", { level: "read", scopeKind: "self" }),
    rule("hr_admin", "employees.**", { level: "read" }),
    rule("hr_admin", "users.me.**", { level: "read", scopeKind: "self" }),
  ]);
  clearCache(); // the role-grant loader caches for ~5s; each test seeds its own rules
});

type ScopeKind = typeof schema.accessRules.$inferInsert.scopeKind;
function rule(subject: string, pattern: string, o: { level: "read" | "write" | "admin" | null; scopeKind?: ScopeKind }) {
  return {
    subject,
    subjectKind: "role" as const,
    namespace: pattern.split(".")[0]!,
    pattern,
    scopeKind: o.scopeKind ?? "all",
    scopeCode: "",
    matchCode: null,
    level: o.level,
    effect: "allow" as const,
  };
}

async function seedPerson(code: string, first: string, role: string) {
  const employeeId = genId();
  const email = `${first.toLowerCase()}@test.example`;
  await deps.db.insert(schema.employees).values({ uuid: employeeId, code, firstName: first, lastName: "Test", workEmail: email, status: "active" });
  await deps.db.insert(schema.users).values({ uuid: genId(), code: `u-${genId().slice(0, 4)}`, email, role, employeeId });
  return { employeeId, code, email };
}

/** Give this person a photo through the ordinary upload path, and answer with the version it was stamped. */
async function givePhoto(employeeId: string): Promise<number> {
  await uploadPhoto(deps, systemActor(), employeeId, JPEG.buffer.slice(0) as ArrayBuffer);
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0]!;
  return +new Date(row.photoAt!);
}

const as = (email: string) => {
  (b as Record<string, unknown>).DEV_FAKE_EMAIL = email;
};
/**
 * Ask for a photo, and ALWAYS read the body - even where the case only cares about the status.
 *
 * The answer is R2's own stream handed to the response rather than bytes buffered in the isolate, which is the
 * point of storing faces unencrypted. A stream nobody reads is a read still open when the test ends, and the
 * pool's isolated storage then refuses to pop its R2 frame ("Failed to pop isolated storage stack frame"). So
 * draining belongs here, once, instead of in whichever case remembers.
 */
async function getPhoto(employeeId: string, version: number, headers: Record<string, string> = {}) {
  const res = await app.request(`/v1/employees/${employeeId}:getPhoto?v=${version}`, { headers }, b as unknown as Record<string, unknown>);
  return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe("a photo is answered to whoever may read the employee", () => {
  it("serves the owner their own face, as an image a browser may keep", async () => {
    const ada = await seedPerson("04-001", "Ada", "employee");
    const v = await givePhoto(ada.employeeId);
    as(ada.email);

    const { res, bytes } = await getPhoto(ada.employeeId, v);
    expect(res.status).toBe(200);
    // `nosniff` is sent on every answer, so the type is what decides whether this paints at all.
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("ETag")).toBe(`W/"${v}"`);
    // The one response in the app that opts out of `no-store`, and only the freshness half of it.
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=604800");
    expect(bytes).toEqual(JPEG);
  });

  it("answers a revalidation with 304 and no bytes", async () => {
    const ada = await seedPerson("04-001", "Ada", "employee");
    const v = await givePhoto(ada.employeeId);
    as(ada.email);

    const { res, bytes } = await getPhoto(ada.employeeId, v, { "If-None-Match": `W/"${v}"` });
    expect(res.status).toBe(304);
    expect(bytes.byteLength).toBe(0);
    expect(res.headers.get("ETag")).toBe(`W/"${v}"`);
  });

  it("refuses a colleague nobody let them read - holding the verb is not the permission", async () => {
    const ada = await seedPerson("04-001", "Ada", "employee");
    const bo = await seedPerson("04-002", "Bo", "employee");
    const v = await givePhoto(bo.employeeId);
    as(ada.email); // holds `employees.*.getPhoto`, reads only her own record

    // The SAME refusal `GET /v1/employees/<bo>` gives her, because it is the same decision: the middleware
    // gates this verb on the record's read as well as on the verb grant (authz.ts READ_GATED_VERBS).
    expect((await getPhoto(bo.employeeId, v)).res.status).toBe(403);
  });

  it("serves it to HR, who may read the record", async () => {
    await seedPerson("04-001", "Ada", "employee");
    const bo = await seedPerson("04-002", "Bo", "employee");
    const hr = await seedPerson("04-003", "Hr", "hr_admin");
    const v = await givePhoto(bo.employeeId);
    as(hr.email);

    expect((await getPhoto(bo.employeeId, v)).res.status).toBe(200);
  });

  it("follows a per-object share: told about one person, told about their face", async () => {
    const ada = await seedPerson("04-001", "Ada", "employee");
    const bo = await seedPerson("04-002", "Bo", "employee");
    const v = await givePhoto(bo.employeeId);
    const adaUser = (await deps.db.select().from(schema.users).where(eq(schema.users.email, ada.email)).limit(1))[0]!;
    as(ada.email);
    expect((await getPhoto(bo.employeeId, v)).res.status).toBe(403);

    // One record, shared with one person - the shape the ACL modal writes.
    await deps.db.insert(schema.accessRules).values({
      subject: adaUser.uuid,
      subjectKind: "user",
      namespace: "employees",
      pattern: `employees.${bo.code}.**`,
      scopeKind: "exact",
      scopeCode: bo.code,
      matchCode: bo.code,
      level: "read",
      effect: "allow",
    });
    clearCache();

    expect((await getPhoto(bo.employeeId, v)).res.status).toBe(200);
  });

  it("still serves a photo stored before photos stopped being encrypted", async () => {
    const ada = await seedPerson("04-001", "Ada", "employee");
    // The old write: through the encrypting lane, with no `enc` marker on the object. The read has to tell the
    // two apart by what the object says about itself, or every face uploaded before the change goes dark.
    const key = `photos/${ada.employeeId}`;
    await deps.docs.put(key, JPEG, "image/jpeg");
    const stamped = new Date();
    await deps.db.update(schema.employees).set({ photoKey: key, photoAt: stamped }).where(eq(schema.employees.uuid, ada.employeeId));
    as(ada.email);

    const { res, bytes } = await getPhoto(ada.employeeId, +stamped);
    expect(res.status).toBe(200);
    expect(bytes).toEqual(JPEG);
  });

  it("is a GET and only a GET: the documented method is the one that works", async () => {
    const ada = await seedPerson("04-001", "Ada", "employee");
    const v = await givePhoto(ada.employeeId);
    as(ada.email);

    const res = await app.request(
      `/v1/employees/${ada.employeeId}:getPhoto`,
      { method: "POST", headers: { "X-Requested-By": "hrms-spa" } },
      b as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(404);
    expect((await getPhoto(ada.employeeId, v)).res.status).toBe(200);
  });

  it("says not found when the person has no photo", async () => {
    const ada = await seedPerson("04-001", "Ada", "employee");
    as(ada.email);
    expect((await getPhoto(ada.employeeId, 0)).res.status).toBe(404);
  });
});
