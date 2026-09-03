import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldsMeta } from "../lib/audit";
import { notFound, invalidArgument } from "../lib/errors";
import { getSettingValue } from "./settings";
import { getAttachmentsFor } from "./attachments";

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
  return toView(defs, values, slots);
}

export async function setIdentityDetails(deps: Deps, actor: AppUser, employeeId: string, input: Record<string, string>) {
  const emp = await loadEmployee(deps, employeeId);
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
  await deps.db.update(schema.employees).set({ identityDetailsEnc: enc, updatedAt: new Date() }).where(eq(schema.employees.uuid, emp.uuid));
  // Field names only - an Aadhaar or passport number must not be copied into the audit table (see bankDetails).
  await audit(deps, actor, "employee.identity_details.update", "employees", emp.uuid, fieldsMeta(next), emp);
  return toView(defs, next, await attachedSlots(deps, emp.uuid));
}
