import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldsMeta } from "../lib/audit";
import { notFound, invalidArgument } from "../lib/errors";
import { getSettingValue } from "./settings";
import { getAttachmentsFor, deleteAttachment } from "./attachments";
import { etagOf } from "../http/serialize";
import { checkEtag, updateAtVersion } from "./versionGuard";

// A field can optionally carry a supporting document (e.g. a scan of the PAN card): none / allowed / required.
export type DocMode = "none" | "allowed" | "required";
// Admin-configurable identity fields (PAN/UAN/Aadhaar etc.), defined centrally in settings.
export type FieldDef = { key: string; label: string; mandatory: boolean; sensitive: boolean; document: DocMode };

// Seed used until an admin customises settings/employee_fields.
const DEFAULT_FIELDS: FieldDef[] = [
  { key: "pan", label: "PAN", mandatory: false, sensitive: true, document: "none" },
  { key: "aadhaar", label: "Aadhaar", mandatory: false, sensitive: true, document: "none" },
  { key: "uan", label: "UAN", mandatory: false, sensitive: false, document: "none" },
  { key: "esi_ip", label: "ESI IP number", mandatory: false, sensitive: false, document: "none" },
];

const docMode = (v: unknown): DocMode => (v === "allowed" || v === "required" ? v : "none");

export async function getFieldDefs(deps: Deps): Promise<FieldDef[]> {
  const cfg = await getSettingValue(deps, "employee_fields", { fields: DEFAULT_FIELDS });
  const fields = Array.isArray(cfg.fields) ? cfg.fields : DEFAULT_FIELDS;
  // Normalise so a partial/old setting can't break the shape.
  return fields
    .filter((f) => f && f.key && f.label)
    .map((f) => ({ key: String(f.key), label: String(f.label), mandatory: !!f.mandatory, sensitive: !!f.sensitive, document: docMode((f as { document?: unknown }).document) }));
}

// The attachment slot for an identity field's supporting document.
export const identityDocSlot = (fieldKey: string) => `identity:${fieldKey}`;

// Identity details follow the same privacy as bank details: owner, HR and super_admin only.
const mask = (v?: string) => {
  if (!v) return undefined;
  return v.length <= 4 ? "••••" : `•••• ${v.slice(-4)}`;
};

// The SAME masking, for a caller outside this module (the table builder renders a sensitive identity field
// exactly as the profile does unless the reader holds `unmask`). Exported rather than reimplemented, so the
// two surfaces can never mask differently.
export const maskIdentityValue = (v?: string) => mask(v) ?? null;

async function loadEmployee(deps: Deps, employeeId: string) {
  const row = (await deps.db.select().from(schema.employees).where(eq(schema.employees.uuid, employeeId)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("employee not found");
  return row;
}

async function readValues(deps: Deps, enc: string | null): Promise<Record<string, string>> {
  if (!enc) return {};
  try {
    return JSON.parse(await deps.encryptor.decrypt(enc)) as Record<string, string>;
  } catch {
    return {};
  }
}

// Server-side raw identity values (decrypted) for an employee, for trusted back-office use (e.g. statutory
// report files). NOT wire-safe - never serialize directly; the masked `toView` is the wire form.
export async function readIdentityValues(deps: Deps, employee: { identityDetailsEnc: string | null }): Promise<Record<string, string>> {
  return readValues(deps, employee.identityDetailsEnc);
}

/**
 * How many employees still hold a stored value for each of these field keys.
 *
 * Removing a field from `settings/employee_fields` is what stops anyone ever opening that employee's identity
 * form again, and the only pruning this module does is lazy - per employee, on the next write to THAT
 * employee's details (see `setIdentityDetails`). So for almost everyone the write never comes and the value
 * stays in the encrypted blob, readable server-side and re-adopted the moment a field with the same slug is
 * added back. "We stopped collecting Aadhaar" and "we no longer hold anyone's Aadhaar" are not the same
 * thing; this is what lets the caller be told which one they are about to do.
 */
export async function identityValueCounts(deps: Deps, keys: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!keys.length) return counts;
  const rows = await deps.db
    .select({ uuid: schema.employees.uuid, enc: schema.employees.identityDetailsEnc })
    .from(schema.employees);
  for (const row of rows) {
    if (!row.enc) continue;
    const values = await readValues(deps, row.enc);
    for (const k of keys) if (values[k]) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

/**
 * Delete these field keys' values from every employee's blob, and the proofs uploaded against them.
 *
 * The lazy prune above touches only the values map, so a removed field left every employee's scanned identity
 * document on the shelf, attached to a slot no surface renders. Removal means removal: both go.
 */
export async function purgeIdentityFields(deps: Deps, actor: AppUser, keys: string[]): Promise<number> {
  if (!keys.length) return 0;
  const rows = await deps.db.select().from(schema.employees);
  let touched = 0;
  for (const row of rows) {
    const slots = keys.map(identityDocSlot);
    for (const slot of slots) await deleteAttachment(deps, actor, "employees", row.uuid, slot);
    if (!row.identityDetailsEnc) continue;
    const values = await readValues(deps, row.identityDetailsEnc);
    const present = keys.filter((k) => values[k] !== undefined);
    if (!present.length) continue;
    for (const k of present) delete values[k];
    const enc = await deps.encryptor.encrypt(JSON.stringify(values));
    await deps.db.update(schema.employees).set({ identityDetailsEnc: enc, updatedAt: new Date() }).where(eq(schema.employees.uuid, row.uuid));
    // Field names only, never values - the same rule the update path follows (see bankDetails).
    await audit(deps, actor, "employee.identity_details.purge", "employees", row.uuid, { fields: present });
    touched++;
  }
  return touched;
}

// Wire-safe view driven by the current field config; sensitive values are masked. `attachedSlots` are the
// slots that currently have an uploaded document, so each field reports `has_doc`.
function toView(defs: FieldDef[], values: Record<string, string>, attachedSlots: Set<string>) {
  return {
    fields: defs.map((f) => {
      const raw = values[f.key];
      return {
        key: f.key,
        label: f.label,
        mandatory: f.mandatory,
        sensitive: f.sensitive,
        document: f.document,
        value: raw ? (f.sensitive ? mask(raw) : raw) : undefined,
        has_value: !!raw,
        has_doc: attachedSlots.has(identityDocSlot(f.key)),
      };
    }),
  };
}

// Slots (identity:<key>) that currently have an uploaded document for this employee - one query.
async function attachedSlots(deps: Deps, employeeId: string): Promise<Set<string>> {
  const atts = await getAttachmentsFor(deps, "employees", employeeId);
  return new Set(atts.map((a) => a.slot));
}

export async function getIdentityDetails(deps: Deps, _actor: AppUser, employeeId: string) {
  // Access (owner / super by default) is enforced by the middleware on employees/<code>/identity.
  const emp = await loadEmployee(deps, employeeId);
  const [defs, values, slots] = [await getFieldDefs(deps), await readValues(deps, emp.identityDetailsEnc), await attachedSlots(deps, employeeId)];
  // The employee row's version, so the caller of the version-guarded PATCH below has one to send back.
  return { ...toView(defs, values, slots), etag: etagOf(+new Date(emp.updatedAt)) };
}

export async function setIdentityDetails(deps: Deps, actor: AppUser, employeeId: string, input: Record<string, string>, ifMatch?: string) {
  const emp = await loadEmployee(deps, employeeId);
  checkEtag(emp, ifMatch);
  const defs = await getFieldDefs(deps);
  const current = await readValues(deps, emp.identityDetailsEnc);
  const next: Record<string, string> = { ...current };
  for (const f of defs) {
    if (!Object.prototype.hasOwnProperty.call(input, f.key)) continue;
    const raw = input[f.key];
    if (raw != null && typeof raw !== "string") throw invalidArgument(`${f.key} must be a string`);
    if (typeof raw === "string" && raw.length > 512) throw invalidArgument(`${f.key} is too long`);
    const v = (raw ?? "").trim();
    // Blank keeps a sensitive value (we never round-trip it to the client) and clears a non-sensitive one.
    if (v) next[f.key] = v;
    else if (!f.sensitive) delete next[f.key];
  }
  // Drop values for fields that no longer exist in the config.
  const known = new Set(defs.map((f) => f.key));
  for (const k of Object.keys(next)) if (!known.has(k)) delete next[k];

  // Required fields must end up with a value.
  const missing = defs.filter((f) => f.mandatory && !next[f.key]).map((f) => f.label);
  if (missing.length) throw invalidArgument(`required: ${missing.join(", ")}`);

  const enc = await deps.encryptor.encrypt(JSON.stringify(next));
  // Version-guarded: this column is one blob merged over a read, so without it two overlapping edits both
  // return 200 and the earlier one's change is simply gone (see setBankDetails, and services/versionGuard.ts).
  const updated = await updateAtVersion(deps, schema.employees, "employee", emp, { identityDetailsEnc: enc, updatedAt: new Date() });
  // Field names only - an Aadhaar or passport number must not be copied into the audit table (see bankDetails).
  await audit(deps, actor, "employee.identity_details.update", "employees", emp.uuid, fieldsMeta(next), emp);
  return { ...toView(defs, next, await attachedSlots(deps, emp.uuid)), etag: etagOf(+new Date(updated.updatedAt)) };
}
