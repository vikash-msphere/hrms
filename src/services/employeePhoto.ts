import { eq, and, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notFound, invalidArgument, forbidden } from "../lib/errors";
import { getEmployee } from "./employees";
import { applyScope } from "./listScope";
import { scopeFor } from "../domain/access";
import { isSuperGrant, EVERYONE_ROLE, roleSubjectsOf } from "../domain/grants";
import { loadObjectExceptionCodes } from "../lib/policyLoad";

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB
// Cap ids per batch request. Each photo can be up to MAX_BYTES and is base64-encoded into the response, so the
// whole batch is held in memory at once: 24 x 3 MB x ~1.33 (base64) stays well under the Worker's ~128 MB.
// The client (photoCache) chunks larger avatar sets to this same cap.
const MAX_BATCH = 24;

// base64-encode an ArrayBuffer in fixed chunks (spreading a large Uint8Array into String.fromCharCode blows
// the call stack).
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Photo editing is allowed for the employee themselves, HR and super_admin.
async function loadEmployee(deps: Deps, employeeId: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  return row;
}

export async function uploadPhoto(deps: Deps, actor: AppUser, employeeId: string, bytes: ArrayBuffer) {
  const emp = await loadEmployee(deps, employeeId);
  if (!bytes.byteLength) throw invalidArgument("empty photo");
  if (bytes.byteLength > MAX_BYTES) throw invalidArgument("photo too large (max 3 MB)");
  const key = `photos/${emp.uuid}`;
  await deps.docs.put(key, bytes, "image/jpeg");
  // `photoAt` is what every browser's face cache keys on (see serialize.ts), so it moves on every upload - the
  // R2 key does not, because it is derived from the employee id.
  const [updated] = await deps.db.update(schema.employees).set({ photoKey: key, photoAt: new Date(), updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid)).returning();
  // Whether there IS one and how big, never the image. Replacing a photo and setting a first one are
  // different acts and the trail should be able to tell them apart.
  await audit(deps, actor, "employee.photo.update", "employees", emp.uuid, { diff: { photo: { from: emp.photoKey ? "an image" : null, to: `${bytes.byteLength} bytes` } } }, updated);
  return updated!;
}

export async function clearPhoto(deps: Deps, actor: AppUser, employeeId: string) {
  const emp = await loadEmployee(deps, employeeId);
  if (emp.photoKey) await deps.docs.delete(emp.photoKey);
  const [updated] = await deps.db.update(schema.employees).set({ photoKey: null, photoAt: new Date(), updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid)).returning();
  await audit(deps, actor, "employee.photo.clear", "employees", emp.uuid, { diff: { photo: { from: emp.photoKey ? "an image" : null, to: null } } }, updated);
  return updated!;
}

// Viewing follows the normal employee visibility (whoever can see the employee can see the photo).
export async function getPhoto(deps: Deps, actor: AppUser, employeeId: string) {
  const emp = await getEmployee(deps, actor, employeeId);
  if (!emp.photoKey) throw notFound("no photo");
  const bytes = await deps.docs.get(emp.photoKey);
  if (!bytes) throw notFound("no photo");
  return bytes;
}

// Batched photo fetch: one request returns the photos for many employees, replacing the per-avatar
// `:getPhoto` N+1 (a 100-row directory went from 100 requests to 1). Visibility MUST match the employees LIST
// exactly - role scope (self/dept/all) PLUS per-object shares/denies - because `getPhoto` itself has no
// service-level check (the middleware allow-grant is its only gate). Ids the caller can't see are silently
// omitted (never an error), so one hidden row never fails the batch. Returns internal uuids; the route maps
// them to `employees/<id>` refs so the wire-encode middleware tokenizes them outbound.
export async function batchGetPhotos(deps: Deps, actor: AppUser, employeeIds: string[]): Promise<{ employeeId: string; dataUri: string }[]> {
  const wanted = [...new Set(employeeIds)].slice(0, MAX_BATCH);
  if (!wanted.length) return [];
  const scope = scopeFor(actor, "employees");
  const roleSubjects = roleSubjectsOf(actor, actor.grant);
  const exc = await loadObjectExceptionCodes(deps, actor.uuid, roleSubjects, "employees");
  scope.shares = exc.shares;
  scope.denies = exc.denies;
  const scopeCond = applyScope(scope, schema.employees.code, schema.employees.uuid);
  const conds = [inArray(schema.employees.uuid, wanted)];
  if (scopeCond) conds.push(scopeCond);
  const rows = await deps.db.select().from(schema.employees).where(and(...conds));
  const out: { employeeId: string; dataUri: string }[] = [];
  for (const r of rows) {
    if (r.deleteTime || !r.photoKey) continue;
    const bytes = await deps.docs.get(r.photoKey);
    if (!bytes) continue;
    out.push({ employeeId: r.uuid, dataUri: `data:image/jpeg;base64,${toBase64(bytes)}` });
  }
  return out;
}

// ---- Signature image (used as the e-signature on document acknowledgements, letters, etc.) ----
// PRIVATE to the owner. Unlike the photo, a signature is forgeable, so it is owner-only at the SERVICE level
// regardless of any employees.* grant (HR/super included): you can only ever read, upload, or clear your OWN
// signature. This is a deliberate hard rule, stronger than the grant system, so the image is never exposed.
function assertOwner(actor: AppUser, employeeId: string) {
  if (!actor.employeeId || actor.employeeId !== employeeId) throw forbidden("a signature is private to its owner");
}

export async function uploadSignature(deps: Deps, actor: AppUser, employeeId: string, bytes: ArrayBuffer, contentType = "image/png") {
  assertOwner(actor, employeeId);
  const emp = await loadEmployee(deps, employeeId);
  if (!bytes.byteLength) throw invalidArgument("empty signature");
  if (bytes.byteLength > MAX_BYTES) throw invalidArgument("signature too large (max 3 MB)");
  const key = `signatures/${emp.uuid}`;
  await deps.docs.put(key, bytes, contentType || "image/png");
  const [updated] = await deps.db.update(schema.employees).set({ signatureKey: key, updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid)).returning();
  await audit(deps, actor, "employee.signature.update", "employees", emp.uuid, { diff: { signature: { from: emp.signatureKey ? "an image" : null, to: `${bytes.byteLength} bytes` } } }, updated);
  return updated!;
}

export async function clearSignature(deps: Deps, actor: AppUser, employeeId: string) {
  assertOwner(actor, employeeId);
  const emp = await loadEmployee(deps, employeeId);
  if (emp.signatureKey) await deps.docs.delete(emp.signatureKey);
  const [updated] = await deps.db.update(schema.employees).set({ signatureKey: null, updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid)).returning();
  await audit(deps, actor, "employee.signature.clear", "employees", emp.uuid, { diff: { signature: { from: emp.signatureKey ? "an image" : null, to: null } } }, updated);
  return updated!;
}

export async function getSignature(deps: Deps, actor: AppUser, employeeId: string) {
  assertOwner(actor, employeeId);
  const emp = await getEmployee(deps, actor, employeeId);
  if (!emp.signatureKey) throw notFound("no signature");
  const bytes = await deps.docs.get(emp.signatureKey);
  if (!bytes) throw notFound("no signature");
  return bytes;
}
