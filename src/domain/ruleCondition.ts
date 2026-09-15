// Per-rule CONDITIONS: the approval-limit axis the grant model had no slot for.
//
// `expenses.my-dept.approve` approves a ₹500 lunch and a ₹5,00,000 invoice identically. A threshold is the
// most-requested control in expense, loan and reimbursement approval, and it does NOT fit `matchToken`: every
// scope token is a predicate on the CODE (who owns this, where it sits in the org), while a limit is a predicate
// on the ROW. Forcing it into a code token would mean inventing a code that encodes an amount.
//
// SUBTRACTIVE BY CONSTRUCTION, and this is the property that keeps `decide()` the sole authority. A condition
// can only ever refuse a request `decide()` already allowed; there is no path by which one grants anything. The
// shape is deliberately the same as the delete axis (permissions.ts `denyingPattern`): a second pass that can
// remove, never add. `test/singleSource.test.ts` is the gate that keeps it that way.
//
// UNION-CONSISTENT. Authority in this app unions - a role's rules, `everyone`, the user's own, each held role -
// and a condition must not break that. So a condition constrains a request only when EVERY rule that authorized
// it carries one: hold an unconditional `expenses.my-dept.approve` alongside a capped one and the unconditional
// rule wins, exactly as two levels resolve to the higher. Anything else would make adding a rule remove access.

/** The comparisons a threshold needs. Numeric only: a limit is a magnitude, and `eq` on money is a trap. */
export const CONDITION_OPS = ["lte", "lt", "gte", "gt"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type RuleCondition = {
  /** A field named by `CONDITION_FIELDS` for the rule's collection - the WIRE name, as an admin authors it. */
  field: string;
  op: ConditionOp;
  value: number;
};

/**
 * Which fields a collection's rules may be conditioned on, as WIRE names mapped to the drizzle column the value
 * is read from. An unlisted field is refused at authoring time, so a typo cannot become a rule that silently
 * refuses everything.
 *
 * A TYPED CONSTANT, not part of the stored policy manifest - unlike `SUPPORTED_SCOPES` next door. The map names
 * DRIZZLE COLUMNS, which are a fact about the schema rather than a policy an org gets to set, and nothing yet
 * wants it configurable per org. Moving it into the manifest is the right step the day one does; it would mean
 * widening `Policy`, its validator and the seed, which is not worth paying for a map with three entries.
 *
 * Kept to MONEY. A threshold on a status or a date is a different feature wearing the same syntax, and each of
 * those has a better home (state visibility, a time window). These are the three the approval queues ask for.
 */
export const CONDITION_FIELDS: Record<string, Record<string, string>> = {
  expenses: { amount: "amount" },
  reimbursements: { amount: "amount" },
  loans: { principal: "principal" },
};

export function conditionFieldsOf(collection: string): Record<string, string> {
  return CONDITION_FIELDS[collection] ?? {};
}

/**
 * The WIRE field names each collection may be conditioned on - what `GET /v1/users/me` carries so the ACL can
 * offer a limit box on exactly the collections that support one, instead of guessing from a parallel list.
 * Same reasoning as `grantableScopes`: the UI must reflect what the engine honours, never a second copy.
 */
export function conditionableFields(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [collection, fields] of Object.entries(CONDITION_FIELDS)) out[collection] = Object.keys(fields);
  return out;
}

/** Parse a stored/authored condition, or null when it is absent or unusable. Never throws - see `evaluate`. */
export function parseCondition(value: unknown): RuleCondition | null {
  const c = typeof value === "string" ? safeJson(value) : value;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const { field, op, value: v } = c as Record<string, unknown>;
  if (typeof field !== "string" || !field) return null;
  if (typeof op !== "string" || !(CONDITION_OPS as readonly string[]).includes(op)) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return { field, op: op as ConditionOp, value: v };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * Does `row` satisfy `c`?
 *
 * FAILS CLOSED on everything it cannot answer: an absent field, a non-numeric value, a row that was never
 * loaded. A condition exists to bound a grant, so "I could not check the limit" must mean the same thing as
 * "over the limit" - the alternative is a cap that evaporates whenever the value is missing, which is precisely
 * when a caller would want it to.
 */
export function satisfies(c: RuleCondition, row: Record<string, unknown> | null | undefined): boolean {
  if (!row) return false;
  const raw = row[c.field];
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return false;
  switch (c.op) {
    case "lte": return n <= c.value;
    case "lt": return n < c.value;
    case "gte": return n >= c.value;
    case "gt": return n > c.value;
  }
}

/**
 * The conditions attached to each grant PATTERN, as loaded for one caller.
 *
 * A pattern maps to one entry per rule that compiled to it: `null` for an unconditional rule, a condition for a
 * capped one. That distinction is the whole union story - see the header - so the nulls are carried rather than
 * filtered out.
 */
export type ConditionIndex = Map<string, (RuleCondition | null)[]>;

/**
 * Is a request authorized by `pattern` allowed to proceed, given the row it is about?
 *
 * `true` when the pattern carries no conditions at all (the overwhelming case, and the fast path), when any rule
 * behind it is unconditional, or when at least one condition is satisfied. The level a rule granted is not
 * consulted: `decide()` already settled that this pattern authorizes this request, and re-deciding it here would
 * be the second authority this file exists not to become.
 */
export function conditionAllows(index: ConditionIndex | undefined, pattern: string | undefined, row: Record<string, unknown> | null | undefined): boolean {
  if (!index || !pattern) return true;
  const list = index.get(pattern);
  if (!list?.length) return true;
  return list.some((c) => c === null || satisfies(c, row));
}
