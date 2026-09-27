import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notFound, invalidArgument, forbidden } from "../lib/errors";
import { getEmployee } from "./employees";

const MAX_BYTES = 3 * 1024 * 1024; // 3 MB

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
  // NOT ENCRYPTED, unlike everything else in the store (lib/docstore.ts says why): a face is not a payslip, and
  // plaintext is what lets the read hand R2's own stream to the browser instead of holding the image in memory.
  await deps.docs.put(key, bytes, "image/jpeg", { encrypt: false });
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

/**
 * Where this employee's photo is, and which version of it.
 *
 * NO ACCESS DECISION HERE, and deliberately not: "if you can view an employee, you can view their face" is
 * decided by the middleware, which gates this verb on the record's own READ as well as on the verb grant
 * (middleware/authz.ts READ_GATED_VERBS). By the time this runs the caller may see the person.
 */
export async function photoRef(deps: Deps, employeeId: string): Promise<{ key: string; version: number }> {
  const emp = await loadEmployee(deps, employeeId);
  if (!emp.photoKey) throw notFound("no photo");
  // `photo_at` is the photo's own version - the ETag and the `?v=` a client asks under (http/serialize.ts).
  return { key: emp.photoKey, version: emp.photoAt ? +new Date(emp.photoAt) : 0 };
}

/** The bytes behind a `photoRef`, as a stream: a plaintext object is handed over exactly as R2 produced it. */
export async function openPhoto(deps: Deps, key: string) {
  const obj = await deps.docs.open(key);
  if (!obj) throw notFound("no photo");
  return obj;
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
