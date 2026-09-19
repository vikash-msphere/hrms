// Per-FIELD read redaction - the read half of field-level access control. The authz middleware has ALREADY
// allowed sub-resource read by the time a handler runs; this can only NARROW the response (drop the fields a
// per-field DENY hides), never widen it. A field with no field-specific rule is covered by the broad
// sub-resource/object allow (the engine's `**` match consumes the trailing tokens), so it never lands in the
// denied set - access inherits by default. Lives in src/http (not scanned by the single-source gate) and uses
// the engine exactly like accessHint.ts: the decision is still rendered by decide(), never re-implemented.
import { decide, type Grant, type SelfContext } from "../domain/permissions";
import { redactedFieldsOf } from "../domain/manifests";
import type { AppUser } from "../env";
import { BANK_FIELDS } from "../services/bankDetails";
import { PERSONAL_FIELDS } from "../services/personalDetails";
import { TAX_FIELDS } from "../services/taxDetails";
import type { Wire } from "./wire";

/**
 * The subset of `keys` the caller may NOT reach among the fields of `<base>.<code>.<subresource>`, at `level`.
 * Each check is a pure in-memory decide() on `<base>.<code>.<subresource>.<key>` - zero DB.
 *
 * `level` defaults to "read" because redaction is what this file is mostly for, but it is a PARAMETER because
 * read and write are decided separately here, exactly as they are for a sub-resource body
 * (middleware/authz.ts bodyDecision gates each key at write level, and the ACL accepts a rule written against
 * `identity.<key>`). A destructive action asked at read level is the converse of the hazard noted over
 * `redactedSub` in routes/employees.ts: somebody allowed to READ a field but denied WRITE on it could replace
 * or delete the document behind it, because all three identity-document verbs shared one read check.
 */
export function deniedFieldKeys(grant: Grant, base: string, code: string, subresource: string, keys: string[], self: SelfContext, level: "read" | "write" = "read"): Set<string> {
  const denied = new Set<string>();
  for (const key of keys) {
    if (!decide(grant, { kind: "standard", resource: `${base}.${code}.${subresource}.${key}`, level }, self).allow) denied.add(key);
  }
  return denied;
}

// The contract's own shape - this file redacts identity fields in place, so it must agree with what the
// identity service emits and what the SPA reads.
type IdentityField = Wire<"identity-field">;
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

// Bank/personal/tax GET return a flat object keyed by field name. A denied key is OMITTED (the SPA renders a
// missing value as "-").
//
// A field does not always reach the wire under its own name, and it does not always reach it ONCE. Bank
// exposes the account number under `account_number_masked`; tax exposes a declared figure again, after the
// verification gate, as `<field>_effective`. So this maps a canonical WRITE key to the EXTRA output keys it
// appears under - `redactFlat` always drops the canonical key itself and then everything listed here, which
// is why an entry naming only the alias is complete rather than a rename that forgets the original.
//
// The two tax entries per figure are deliberate: `prior_employer_income_effective` carries the VERIFIED
// amount, so it has to disappear if either the declared figure or the verified one is denied - whichever
// half of the pair an admin reached for, the effective column would otherwise still publish it.
export const READ_KEY: Record<string, Record<string, readonly string[]>> = {
  "bank-account": { account_number: ["account_number_masked"] },
  tax: {
    prior_employer_income: ["prior_employer_income_effective"],
    verified_income: ["prior_employer_income_effective"],
    prior_employer_tds: ["prior_employer_tds_effective"],
    verified_tds: ["prior_employer_tds_effective"],
  },
};
// The canonical (write) field keys per flat sub-resource - the set a per-field rule can target.
//
// IMPORTED FROM THE SERVICES THAT OWN THE FIELDS, never re-typed here. This list is what makes a per-field
// DENY effective: `deniedFieldKeys` only ever asks about keys that appear in it, so a field the list does not
// mention cannot be denied and a rule written against it does nothing at all - a field ACL failing OPEN, with
// no error anywhere. The two copies had already drifted apart (this file listed a `branch` that bank details
// did not store), which is the same mistake pointing the harmless way. test/fieldAccessDrift.test.ts holds
// the pair together.
export const FLAT_KEYS: Record<string, readonly string[]> = {
  "bank-account": BANK_FIELDS,
  "personal-info": PERSONAL_FIELDS,
  // `tax` WAS THE MISSING ONE, and it was missing in the direction that leaks. It has been in
  // domain/manifests.ts SUBRESOURCE_BODY since field-level control was written, which is what makes its write
  // body per-field gated AND what makes `isFieldScopeTarget` accept a rule written against `tax.<key>` - so
  // the ACL surface offered the rule, the validator took it, the row was stored, and on READ nothing consulted
  // it: routes/employees.ts served the tax view straight out of the service while its three siblings each went
  // through a redactor. An admin denying a read of somebody's prior-employer figures was told they had.
  //
  // Exactly the failure the header of this file describes for a drifted FLAT_KEYS, reached by a sub-resource
  // never being added to it at all - so test/fieldAccessDrift.test.ts now holds all three pairs, not two.
  tax: TAX_FIELDS,
};

export function redactFlat<T extends Record<string, unknown>>(view: T, subresource: string, grant: Grant, code: string, self: SelfContext): T {
  const keys = FLAT_KEYS[subresource] ?? [];
  const denied = deniedFieldKeys(grant, "employees", code, subresource, [...keys], self);
  if (!denied.size) return view;
  const out = { ...view };
  // The canonical key AND every output alias it also reaches the wire under (see READ_KEY). Deleting a key
  // the view does not carry is a no-op, so naming both is free and cannot leave one behind.
  for (const key of denied) for (const outKey of [key, ...(READ_KEY[subresource]?.[key] ?? [])]) delete out[outKey];
  return out;
}

/**
 * Which of `fields` (WIRE column names) this caller may NOT read on a base-record row of `collection`.
 *
 * The grid projects raw columns, so it bypassed the one place `policy.redacted_fields` is enforced:
 * http/accessHint.ts `redactFields`, which every serialized resource passes through. A deny on
 * `tickets.*.description`, `leave-requests.*.reason`, `candidates.*.email` or `offers.*.base_comp` - the whole
 * point of that manifest, and what the ACL's field templates author - therefore removed the field from every
 * list and item response in the app and left it fully readable as a column of a saved grid, on the same rows,
 * to the same caller. Decided here per ROW, on the row's own code, because that is the key the redaction is
 * scoped by.
 *
 * Same fail-closed rule as `deniedSubresourceKeys` above: a row with no code cannot be decided against.
 */
export function deniedRedactedFields(
  grant: Grant,
  collection: string,
  code: string | null | undefined,
  fields: readonly string[],
  self: SelfContext,
): Set<string> {
  if (!fields.length) return new Set();
  if (!code) return new Set(fields);
  const out = new Set<string>();
  for (const f of fields) {
    if (!decide(grant, { kind: "standard", resource: `${collection}.${code}.${f}`, level: "read" }, self).allow) out.add(f);
  }
  return out;
}

/**
 * The same decision as a LOOKUP, for a surface that holds rows of many collections at once and has to ask it
 * per row: hand it a collection and that row's code, get back the redacted fields this caller may not read
 * there. Memoized per (collection, code), because a page of hits routinely repeats both.
 *
 * Global search is the caller that needed it. Its hits are rows of two dozen collections, and it renders text
 * COPIED from them into an index - so the gate every serializer applies could not reach it, and a deny on
 * `leave-requests.*.reason` hid the reason everywhere in the app except the one place it was the title of the
 * search result.
 */
export type RedactionGate = (collection: string, code: string | null | undefined) => readonly string[];

export function redactionGateFor(user: AppUser): RedactionGate {
  const self = { employeeCode: user.employeeCode };
  const memo = new Map<string, readonly string[]>();
  return (collection, code) => {
    const fields = redactedFieldsOf(user.policy, collection);
    if (!fields.length) return [];
    const key = `${collection}|${code ?? ""}`;
    let denied = memo.get(key);
    if (denied === undefined) memo.set(key, (denied = [...deniedRedactedFields(user.grant, collection, code, fields, self)]));
    return denied;
  };
}
