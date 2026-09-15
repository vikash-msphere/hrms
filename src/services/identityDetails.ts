import { and, asc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, fieldsMeta } from "../lib/audit";
import { notFound, invalidArgument } from "../lib/errors";
import { getSettingValue } from "./settings";
import { getAttachmentsFor } from "./attachments";
import { checkSubEtag, subResourceEtag, updateAtVersion } from "./versionGuard";

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

/** The drained job that carries an identity-field purge past the invocation that started it. */
export const IDENTITY_PURGE_JOB = "identity.purgeFields";

/** Where a purge has got to. `docs` clears the uploaded proofs, then `values` walks the blobs by uuid. */
export type IdentityPurgeCursor = { keys: string[]; phase: "docs" | "values"; after?: string };

// Per-slice budgets. A D1 statement and an R2 call are each a SUBREQUEST, and the Workers budget is 1000 per
// invocation on Standard (50 on Free - wrangler.toml says so). A proof costs an R2 delete + a row delete + an
// audit insert; an employee costs an update + an audit insert. Both slices sit well inside the Free ceiling so
// the drain makes progress on either plan.
const PURGE_DOC_SLICE = 15;
const PURGE_ROW_SLICE = 20;

/**
 * ONE SLICE of "delete these field keys' values from every employee's blob, and the proofs uploaded against
 * them". Resumable, because the whole walk does not fit in one invocation and must never be attempted there.
 *
 * The lazy prune above touches only the values map, so a removed field left every employee's scanned identity
 * document on the shelf, attached to a slot no surface renders. Removal means removal: both go.
 *
 * WHY THIS IS A JOB. It used to run synchronously inside `PATCH /v1/settings/employee_fields`, over
 * `select().from(employees)` with no bound, calling `deleteAttachment` (four round trips of its own) for every
 * employee x every removed key whether or not that employee had one. Around 200 employees and a single removed
 * field already exceeded the subrequest ceiling - and nothing about it was transactional, so an invocation
 * killed partway had irreversibly wiped the first N employees' values and proofs, left the rest untouched,
 * left the settings row still listing the field, and answered 500 to a caller who had confirmed a clean
 * delete. Retrying repeated the partial destruction from the top.
 *
 * The caller now writes the settings row FIRST and enqueues this; the drain carries it, and a tick that dies
 * loses at most one slice and resumes from the same cursor.
 */
export async function purgeIdentityFieldsSlice(
  deps: Deps,
  actor: AppUser,
  cursor: IdentityPurgeCursor,
): Promise<{ done: boolean; next?: IdentityPurgeCursor; touched: number }> {
  const keys = cursor.keys.filter(Boolean);
  if (!keys.length) return { done: true, touched: 0 };

  if (cursor.phase === "docs") {
    // The proofs are read from the ATTACHMENTS table, not from the roster: it is the set that actually holds
    // documents, so an org where nobody uploaded one costs a single empty select instead of a round trip per
    // employee per key. Deleted rows leave the result set, so re-querying each slice IS the cursor.
    const slots = keys.map(identityDocSlot);
    const docs = await deps.db
      .select()
      .from(schema.attachments)
      .where(and(eq(schema.attachments.collection, "employees"), inArray(schema.attachments.slot, slots)))
      .orderBy(asc(schema.attachments.uuid))
      .limit(PURGE_DOC_SLICE);
    for (const doc of docs) {
      await deps.docs.delete(doc.r2Key);
      await deps.db.delete(schema.attachments).where(eq(schema.attachments.uuid, doc.uuid));
      await audit(deps, actor, "attachment.delete", "employees", doc.objectId, { slot: doc.slot });
    }
    // A full slice means there may be more; anything short means the table is clear of these slots.
    if (docs.length === PURGE_DOC_SLICE) return { done: false, next: { ...cursor, phase: "docs" }, touched: docs.length };
    return { done: false, next: { keys, phase: "values" }, touched: docs.length };
  }

  // Only employees who actually carry a blob: a null column has nothing to prune, and reading the whole
  // roster to decide that was most of the old cost.
  const rows = await deps.db
    .select({ uuid: schema.employees.uuid, enc: schema.employees.identityDetailsEnc })
    .from(schema.employees)
    .where(and(isNotNull(schema.employees.identityDetailsEnc), cursor.after ? gt(schema.employees.uuid, cursor.after) : undefined))
    .orderBy(asc(schema.employees.uuid))
    .limit(PURGE_ROW_SLICE);
  let touched = 0;
  for (const row of rows) {
    const values = await readValues(deps, row.enc);
    const present = keys.filter((k) => values[k] !== undefined);
    if (!present.length) continue;
    for (const k of present) delete values[k];
    const enc = await deps.encryptor.encrypt(JSON.stringify(values));
    await deps.db.update(schema.employees).set({ identityDetailsEnc: enc, updatedAt: new Date() }).where(eq(schema.employees.uuid, row.uuid));
    // Field names only, never values - the same rule the update path follows (see bankDetails).
    await audit(deps, actor, "employee.identity_details.purge", "employees", row.uuid, { fields: present });
    touched++;
  }
  // The cursor advances over EVERY row in the slice, including the ones with nothing to prune - it is a
  // position in the roster, not a count of work done.
  const last = rows[rows.length - 1]?.uuid;
  if (rows.length === PURGE_ROW_SLICE && last) return { done: false, next: { keys, phase: "values", after: last }, touched };
  return { done: true, touched };
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
  // THIS BLOB's version, so the caller of the version-guarded PATCH below has one to send back. Not the
  // employee row's: all four encrypted sub-resources share that timestamp, so a row-derived version made an
  // edit to any one of them conflict with an open form on the other three
  // (services/versionGuard.ts#subResourceEtag).
  return { ...toView(defs, values, slots), etag: subResourceEtag(emp.identityDetailsEnc) };
}

export async function setIdentityDetails(deps: Deps, actor: AppUser, employeeId: string, input: Record<string, string>, ifMatch?: string) {
  const emp = await loadEmployee(deps, employeeId);
  checkSubEtag(emp.identityDetailsEnc, ifMatch);
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
  await updateAtVersion(deps, schema.employees, "employee", emp, { identityDetailsEnc: enc, updatedAt: new Date() });
  // Field names only - an Aadhaar or passport number must not be copied into the audit table (see bankDetails).
  await audit(deps, actor, "employee.identity_details.update", "employees", emp.uuid, fieldsMeta(next), emp);
  return { ...toView(defs, next, await attachedSlots(deps, emp.uuid)), etag: subResourceEtag(enc) };
}
