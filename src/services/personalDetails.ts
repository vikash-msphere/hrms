import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldsMeta } from "../lib/audit";
import { notFound, invalidArgument } from "../lib/errors";
import { etagOf } from "../http/serialize";
import { checkEtag, updateAtVersion } from "./versionGuard";

// Personal contact + emergency info. Stored as an encrypted JSON blob; returned in full to the
// employee, HR and super_admin (not masked - HR needs to read these). Health data lives here too.
//
// EXPORTED because http/fieldAccess.ts needs this list at RUNTIME to know which keys a per-field rule may
// deny, and it used to keep a hand-written copy of it. A field added here and forgotten there can never be
// denied - a configured field-level DENY on it silently does nothing, which is a field ACL failing open. One
// list, imported; test/fieldAccessDrift.test.ts pins that it stays the one list.
export const PERSONAL_FIELDS = [
  "personal_email",
  "personal_phone",
  "alternate_phone",
  "date_of_birth",
  "gender",
  "marital_status",
  "communication_address",
  "permanent_address",
  "emergency_name",
  "emergency_phone",
  "emergency_relation",
  "emergency2_name",
  "emergency2_phone",
  "emergency2_relation",
  "blood_group",
  "allergies",
  "medical_notes",
] as const;

export type PersonalDetails = Partial<Record<(typeof PERSONAL_FIELDS)[number], string>> & { same_as_communication?: boolean };

async function loadEmployee(deps: Deps, employeeId: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  return row;
}

async function read(deps: Deps, enc: string | null): Promise<PersonalDetails> {
  if (!enc) return {};
  try {
    return JSON.parse(await deps.encryptor.decrypt(enc)) as PersonalDetails;
  } catch {
    return {};
  }
}

export async function getPersonalDetails(deps: Deps, _actor: AppUser, employeeId: string): Promise<PersonalDetails & { etag: string }> {
  // Access (owner / super by default) is enforced by the middleware on employees/<code>/personal-info.
  const emp = await loadEmployee(deps, employeeId);
  // The VERSION rides the view. `setPersonalDetails` is version-guarded, but the guard is inert unless the
  // caller can send an If-Match, and a caller can only send one if a read gave it to them - which is why all
  // three SPA callers of this record were doing full-blob writes with no version at all. The etag is the
  // employee row's, the same one the collection serializer emits, so client and server agree by construction.
  return { ...(await read(deps, emp.personalDetailsEnc)), etag: etagOf(+new Date(emp.updatedAt)) };
}

/**
 * Write the fields this call NAMES, and leave the rest of the record alone.
 *
 * A JSON Merge Patch, like every other write in the app: a field that is absent is unchanged, and a field
 * sent empty is cleared (the SPA sends "" for a box somebody emptied, and never null - web/src/api.ts).
 *
 * It used to replace the whole blob with whatever arrived, which made these details the one record where two
 * editors fight. They are edited from two dialogs on the same page - contact details, and the emergency
 * contact - so saving one after opening the other wiped the fields the other one had just written, and the
 * loser only found out by reloading. Merging is also what the route says it does: it is a PATCH.
 */
export async function setPersonalDetails(deps: Deps, actor: AppUser, employeeId: string, input: PersonalDetails, ifMatch?: string): Promise<PersonalDetails & { etag: string }> {
  const emp = await loadEmployee(deps, employeeId);
  checkEtag(emp, ifMatch);
  const next: PersonalDetails = { ...(await read(deps, emp.personalDetailsEnc)) };
  const MAX_LEN = 2000;
  for (const k of PERSONAL_FIELDS) {
    const raw = input[k];
    if (raw == null) continue;
    if (typeof raw !== "string") throw invalidArgument(`${k} must be a string`);
    if (raw.length > MAX_LEN) throw invalidArgument(`${k} is too long`);
    const v = raw.trim();
    if (v) next[k] = v;
    else delete next[k]; // sent empty = cleared, which is how the forms say "I took this out"
  }
  // When the permanent address mirrors the communication address, store the flag and copy it across. The
  // flag is merged like the fields are: sent false it comes off, absent it stays as it was.
  if (input.same_as_communication) {
    next.same_as_communication = true;
    if (next.communication_address) next.permanent_address = next.communication_address;
  } else if (input.same_as_communication === false) {
    delete next.same_as_communication;
  }
  const enc = await deps.encryptor.encrypt(JSON.stringify(next));
  // The merge above fixes two dialogs fighting WITHIN one read; the version in the WHERE is what stops two
  // reads fighting (services/versionGuard.ts). Both are needed - merging a stale blob still discards whatever
  // landed after it was read.
  const updated = await updateAtVersion(deps, schema.employees, "employee", emp, { personalDetailsEnc: enc, updatedAt: new Date() });
  // Field names only, never the values (see bankDetails): a home address and a date of birth are the record.
  await audit(deps, actor, "employee.personal_details.update", "employees", emp.uuid, fieldsMeta(next), emp);
  // The version this write produced, so the dialog that stays open holds a current one rather than the one it
  // read - the same reason the card dialogs take the etag off their own responses.
  return { ...next, etag: etagOf(+new Date(updated.updatedAt)) };
}
