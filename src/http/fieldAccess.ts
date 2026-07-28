// Per-FIELD read redaction - the read half of field-level access control. The authz middleware has ALREADY
// allowed sub-resource read by the time a handler runs; this can only NARROW the response (drop the fields a
// per-field DENY hides), never widen it. A field with no field-specific rule is covered by the broad
// sub-resource/object allow (the engine's `**` match consumes the trailing tokens), so it never lands in the
// denied set - access inherits by default. Lives in src/http (not scanned by the single-source gate) and uses
// the engine exactly like accessHint.ts: the decision is still rendered by decide(), never re-implemented.
import { decide, type Grant, type SelfContext } from "../domain/permissions";

// The subset of `keys` the caller may NOT read among the fields of `<base>.<code>.<subresource>`. Each check
// is a pure in-memory decide() on `<base>.<code>.<subresource>.<key>` at read level - zero DB.
export function deniedFieldKeys(grant: Grant, base: string, code: string, subresource: string, keys: string[], self: SelfContext): Set<string> {
  const denied = new Set<string>();
  for (const key of keys) {
    if (!decide(grant, { kind: "standard", resource: `${base}.${code}.${subresource}.${key}`, level: "read" }, self).allow) denied.add(key);
  }
  return denied;
}

type IdentityField = { key: string; label: string; mandatory: boolean; sensitive: boolean; document?: string; value?: string; has_value: boolean; has_doc?: boolean; denied?: boolean };
type IdentityView = { fields: IdentityField[] };

// Identity GET returns a `fields[]` array. Keep a denied field's ROW (its key is admin-configured, so a
// vanished row would read as "not configured"), but blank its value and flag it `denied` so the SPA shows a
// restricted marker instead of an empty "-".
export function redactIdentity(view: IdentityView, grant: Grant, code: string, self: SelfContext): IdentityView {
  const denied = deniedFieldKeys(grant, "employees", code, "identity", view.fields.map((f) => f.key), self);
  if (!denied.size) return view;
  // Blank a denied field's value AND its has_doc, so the SPA never offers a download for a field the caller
  // can't read (the download route gates this too; this just keeps the affordance honest).
  return { fields: view.fields.map((f) => (denied.has(f.key) ? { ...f, value: undefined, has_value: false, has_doc: false, denied: true } : f)) };
}

// Bank/personal GET return a flat object keyed by field name. A denied key is OMITTED (the SPA renders a
// missing value as "-"). Bank exposes the account number under `account_number_masked`, so a deny on the
// canonical write key `account_number` must drop that output key - hence the read-key remap.
const READ_KEY: Record<string, Record<string, string>> = {
  "bank-account": { account_number: "account_number_masked" },
};
// The canonical (write) field keys per flat sub-resource - the set a per-field rule can target.
const FLAT_KEYS: Record<string, readonly string[]> = {
  "bank-account": ["bank_name", "account_name", "account_number", "branch", "ifsc_code", "currency_code"],
  "personal-info": [
    "personal_email", "personal_phone", "alternate_phone", "date_of_birth", "gender", "marital_status",
    "communication_address", "permanent_address", "emergency_name", "emergency_phone", "emergency_relation",
    "emergency2_name", "emergency2_phone", "emergency2_relation", "blood_group", "allergies", "medical_notes",
  ],
};

export function redactFlat<T extends Record<string, unknown>>(view: T, subresource: string, grant: Grant, code: string, self: SelfContext): T {
  const keys = FLAT_KEYS[subresource] ?? [];
  const denied = deniedFieldKeys(grant, "employees", code, subresource, [...keys], self);
  if (!denied.size) return view;
  const out = { ...view };
  const remap = READ_KEY[subresource] ?? {};
  for (const key of denied) delete out[remap[key] ?? key];
  return out;
}
