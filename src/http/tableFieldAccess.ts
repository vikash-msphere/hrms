// The two authz questions a custom grid asks that a list scope cannot answer: may this caller read this
// employee's PII sub-resource on THIS row, and may they see a masked value unmasked.
//
// Lives in src/http for the same reason fieldAccess.ts and accessHint.ts do: the decision is rendered by the
// engine's own `decide()`, never re-implemented, and this is the layer allowed to call it (a service is not -
// see test/singleSource.test.ts). It can only NARROW: the request has already been authorized by the
// middleware by the time a runner calls any of this.
import { decide, resolveRequest, type Grant, type SelfContext } from "../domain/permissions";
import { SCOPE_PROBE_CODE, SCOPE_PROBE_LEAF } from "../domain/access";
import { redactedFieldsOf } from "../domain/manifests";
import type { AppUser } from "../env";
import { selfContextOf } from "../lib/selfContext";
import { deniedFieldKeys } from "./fieldAccess";

/**
 * Which of `keys` this caller may NOT read under `employees.<code>.<subresource>`.
 *
 * Two decisions, in the order the profile endpoint takes them: the sub-resource itself (no read on
 * `employees.<code>.identity` hides every identity field on that row), then each field under it. Both are
 * pure in-memory matches - a page of 100 people costs zero extra reads.
 *
 * `null` code (a row with no hierarchy code) denies everything: an access decision needs a scope key, and
 * missing one fails closed.
 */
export function deniedSubresourceKeys(
  grant: Grant,
  code: string | null | undefined,
  subresource: string,
  keys: string[],
  self: SelfContext,
): Set<string> {
  if (!code) return new Set(keys);
  if (!decide(grant, { kind: "standard", resource: `employees.${code}.${subresource}`, level: "read" }, self).allow) {
    return new Set(keys);
  }
  return deniedFieldKeys(grant, "employees", code, subresource, keys, self);
}

/**
 * Does this caller hold `unmask` - the virtual capability that turns a masked PAN or a masked account number
 * into the real value?
 *
 * Decided as the other virtual capabilities are (the middleware decides `tax-verifications` exactly so): the
 * request a real `GET /v1/unmask` would resolve to. Private by default - no seeded grant names `unmask`, so
 * only super passes until an admin grants it, and the per-field read above still has to allow as well.
 */
export function canUnmask(user: AppUser): boolean {
  return decide(user.grant, resolveRequest("GET", "/v1/unmask"), { employeeCode: user.employeeCode }).allow;
}

/**
 * The same question, PER FIELD: may this caller see the real value of THIS masked field?
 *
 * `unmask` was one switch over every masked value in the app - a full PAN, a full Aadhaar and a full bank
 * account number were the same grant - so the only way to let payroll read account numbers for a bank file
 * was to let them read everybody's statutory ids too. The engine could always express the narrower thing: a
 * field rule compiles to `unmask.*.<subresource>.<key>.**`, and `identity.uan` / `bank-account.account_number`
 * are already valid field targets (manifests.ts isFieldScopeTarget). Nothing asked it.
 *
 * Returns a PREDICATE rather than a boolean because a single run renders many fields and the broad answer is
 * worth deciding once: a caller holding plain `unmask` short-circuits every field, and only a narrowed holder
 * pays for a decision per column.
 *
 * The probe uses the scope-probe sentinel in the id position for the same reason `domain/access.ts` does:
 * `unmask` has no rows, so there is no real code to name, and a rule that reaches the sentinel can only be an
 * unscoped one. This NARROWS - it is ANDed with the per-field read on the employee's own sub-resource, which
 * `deniedFieldKeys` above has already applied - so a caller who cannot read the field never reaches here.
 */
export function unmaskGate(user: AppUser): (field: { subresource?: string; fieldKey?: string }) => boolean {
  const self = { employeeCode: user.employeeCode };
  if (canUnmask(user)) return () => true;
  return (field) => {
    if (!field.subresource || !field.fieldKey) return false; // nothing precise to ask about -> the broad answer stands
    const resource = `unmask.${SCOPE_PROBE_CODE}.${field.subresource}.${field.fieldKey}`;
    return decide(user.grant, { kind: "standard", resource, level: "read" }, self).allow;
  };
}

/**
 * The catalogue's own read gate: may this caller read this FIELD on any row of the collection they can reach?
 *
 * The builder's promise is that it offers what the caller can have, so the field catalogue already drops every
 * field of a collection they may not list. Field-level access was the half it did not ask, and there are two
 * kinds of it: a PII sub-resource (`employees.<code>.identity[.<key>]`, the gate the profile endpoint runs) and
 * a redacted base field (`policy.redacted_fields`, the gate every serializer runs). Without this, a caller
 * denied `identity` was offered the whole Identity group and a caller denied `tickets.*.description` was
 * offered that column, and both found out by adding it and getting a grid of restricted markers back.
 *
 * TWO PROBE CODES, OR-ed, because access is per row and a catalogue answers before there are any rows:
 *   - the scope-probe sentinel, which only an UNSCOPED rule reaches (`domain/access.ts`), and
 *   - the caller's own code, plus a leaf under it, which is what a `me`-scoped rule reaches.
 * A field readable under either is offered; one readable under neither cannot be read on ANY row this caller
 * can reach, so it is not offered. Erring towards offering is deliberate: the runner still decides per row
 * (`deniedSubresourceKeys`, `deniedRedactedFields`), so a field that slips through is blanked there, while a
 * field wrongly withheld here is a column the builder would not let them pick at all.
 */
export function catalogueFieldGate(user: AppUser, self: SelfContext = selfContextOf(user)): (field: {
  collection: string;
  subresource?: string;
  fieldKey?: string;
  /** The wire column name, for a plain base field that `policy.redacted_fields` may gate. */
  wireName?: string;
}) => boolean {
  const own = user.employeeCode;
  // The codes a rule could match for this caller: unscoped (the sentinel), their own record, a row owned by
  // them (an owned code is `<employeeCode>-<leaf>`), and - because a manager's PII reach is over OTHER people -
  // one real code from their reporting line, which is the only shape `my-reports` / `my-org` can match. Without
  // that last pair, a role granted `employees.my-reports.identity.**` and no self grant of its own was offered
  // no identity column at all, while the run returned it for every report on the page.
  const chain = [self.reportCodes?.[0], self.orgCodes?.[0]].filter((c): c is string => !!c);
  const codes = [
    SCOPE_PROBE_CODE,
    ...(own ? [own, `${own}-${SCOPE_PROBE_LEAF}`] : []),
    ...chain.flatMap((c) => [c, `${c}-${SCOPE_PROBE_LEAF}`]),
  ];
  const readable = (resource: (code: string) => string) =>
    codes.some((code) => decide(user.grant, { kind: "standard", resource: resource(code), level: "read" }, self).allow);

  // The sub-resource question is the same one for every field of a source, so it is asked once - a dozen
  // identity fields re-asking "may I read identity" is the shape of decision that gets re-decided per cell.
  const subMemo = new Map<string, boolean>();
  return (field) => {
    if (field.subresource) {
      const sub = field.subresource;
      let ok = subMemo.get(sub);
      if (ok === undefined) subMemo.set(sub, (ok = readable((code) => `employees.${code}.${sub}`)));
      if (!ok) return false;
      return field.fieldKey ? readable((code) => `employees.${code}.${sub}.${field.fieldKey}`) : true;
    }
    if (!field.wireName) return true;
    const redacted = redactedFieldsOf(user.policy, field.collection);
    if (!redacted.includes(field.wireName)) return true;
    return readable((code) => `${field.collection}.${code}.${field.wireName}`);
  };
}
