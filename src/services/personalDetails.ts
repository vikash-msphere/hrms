import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldsMeta } from "../lib/audit";
import { notFound, invalidArgument } from "../lib/errors";

// Personal contact + emergency info. Stored as an encrypted JSON blob; returned in full to the
// employee, HR and super_admin (not masked - HR needs to read these). Health data lives here too.
const FIELDS = [
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

export type PersonalDetails = Partial<Record<(typeof FIELDS)[number], string>> & { same_as_communication?: boolean };

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

export async function getPersonalDetails(deps: Deps, _actor: AppUser, employeeId: string): Promise<PersonalDetails> {
  // Access (owner / super by default) is enforced by the middleware on employees/<code>/personal-info.
  const emp = await loadEmployee(deps, employeeId);
  return read(deps, emp.personalDetailsEnc);
}

export async function setPersonalDetails(deps: Deps, actor: AppUser, employeeId: string, input: PersonalDetails): Promise<PersonalDetails> {
  const emp = await loadEmployee(deps, employeeId);
  const next: PersonalDetails = {};
  const MAX_LEN = 2000;
  for (const k of FIELDS) {
    const raw = input[k];
    if (raw == null) continue;
    if (typeof raw !== "string") throw invalidArgument(`${k} must be a string`);
    if (raw.length > MAX_LEN) throw invalidArgument(`${k} is too long`);
    const v = raw.trim();
    if (v) next[k] = v;
  }
  // When the permanent address mirrors the communication address, store the flag and copy it across.
  if (input.same_as_communication) {
    next.same_as_communication = true;
    if (next.communication_address) next.permanent_address = next.communication_address;
  }
  const enc = await deps.encryptor.encrypt(JSON.stringify(next));
  await deps.db.update(schema.employees).set({ personalDetailsEnc: enc, updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid));
  // Field names only, never the values (see bankDetails): a home address and a date of birth are the record.
  await audit(deps, actor, "employee.personal_details.update", "employees", emp.uuid, fieldsMeta(next), emp);
  return next;
}
