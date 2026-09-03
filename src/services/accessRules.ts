// The ONE access-rule management service - roles and users, identical mechanism. Each rule is a row in
// access_rules (the sole source of record); the service builds the verbatim pattern ONCE from the structured
// input, then reuses `deriveNarrowing` to fill the narrowing columns and sets match_code for exact rules -
// byte-identical to what the seed's `compileGrant` produces, so a created row is indistinguishable from a
// seeded one and the engine + BOLA oracles never change. No grant blob, no recompile. Super-only via the
// `access-rules` collection key (the middleware gates it).
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, auditMany } from "../lib/audit";
import { clearCache, clearCachePrefix } from "../lib/cache";
import { notFound, failedPrecondition, alreadyExists, invalidArgument } from "../lib/errors";
import { validateAccessRule, type AccessRuleInput } from "../domain/policyValidate";
import { deriveNarrowing } from "../domain/compileGrants";
import { EVERYONE_ROLE } from "../domain/grants";
import { uuidToCode, codeToUuid } from "../lib/authzResolve";
import { getSettingValue } from "./settings";
import { accessAdminEmployeeIds } from "./accessRequest";
import { notifyMany } from "./notifications";
import { toAccessRuleResource } from "../http/serialize";

// Build the verbatim pattern for a normalized rule. The id-position token encodes the scope (me / my-dept /
// <code> / <code>-* / * for a field rule); a field rule inserts the field token; the tail is the verb for a
// custom-method rule, else `**` (full subtree at that scope). This is the SINGLE pattern-derivation site.
export async function buildPattern(deps: Deps, r: AccessRuleInput): Promise<string> {
  // The create gate is the bare 1-token collection pattern (`<collection>`): it matches the collection-level
  // POST/list but no individual object - distinct from `<collection>.**` (every object). Short-circuit before
  // the id/field/verb assembly, which would otherwise append a `.**` tail.
  if (r.scope === "create") return r.collection;
  let idToken = "";
  if (r.scope === "self") idToken = "me";
  else if (r.scope === "dept") idToken = "my-dept";
  else if (r.scope === "exact" || r.scope === "subtree") {
    const ref = r.scopeRef!;
    const slash = ref.indexOf("/");
    const code = await uuidToCode(deps, ref.slice(0, slash), ref.slice(slash + 1));
    if (!code) throw notFound("scope_ref object not found");
    idToken = r.scope === "subtree" ? `${code}-*` : code;
  } else if (r.field) idToken = "*"; // scope=all + field -> that field on any item (`collection.*.<field>`)
  // scope=all + verb -> `collection.**.<verb>`, NOT `collection.*.<verb>`. A custom method is either
  // COLLECTION-level (`POST /v1/announcements:markAllRead` -> the 2-token key `announcements.markAllRead`) or
  // ITEM-level (`.../<code>:approve` -> 3 tokens); the ACL input does not distinguish them, and a `*` id token
  // can only ever match the item form - so a grant for a collection-level verb was stored, displayed, and
  // silently inert (every non-super caller kept getting 403). `**` matches zero-or-more tokens in the id
  // position, so ONE all-scope rule covers both forms, which is exactly what "all" means for a verb.
  else if (r.verb) idToken = "**";
  const toks = [r.collection];
  if (idToken) toks.push(idToken);
  if (r.field) toks.push(r.field);
  toks.push(r.verb ? r.verb : "**"); // verb -> the custom-method key; `**` -> standard methods + sub-resources
  return toks.join(".");
}

const ruleById = (id: string) => eq(schema.accessRules.uuid, id);

// Bust the cached broad grant a rule edit affects. A user rule busts that user's grant; a normal role rule
// busts that role's grant; an `everyone` rule busts the WHOLE `grant:` band, since `everyone` is unioned into
// every role's cached grant (loadRoleGrant). `everyone` edits are rare admin actions, so the band flush is fine.
function bustGrantCache(subjectKind: "role" | "user", subject: string): void {
  if (subjectKind === "user") clearCache(`userGrant:${subject}`);
  else if (subject === EVERYONE_ROLE) clearCachePrefix("grant:");
  else clearCache(`grant:${subject}`);
  // Per-object rules (ACL shares/denies) are cached per CALLER, not per subject - one entry covers a user and
  // their roles - so there is no single key to drop for them. Rule edits are rare admin actions, so the whole
  // band goes; it refills on the next request that needs it.
  clearCachePrefix("objRules:");
}

// Four-eyes on permission changes: opt-in per org via the `access-approval` settings blob. While it is on,
// every rule write becomes a PENDING row instead of an active one (see the `status` column), and a SECOND
// access admin has to approve it. Off by default - nothing changes for orgs that don't want the ceremony.
// One-admin org caveat: with nobody else to approve, the way out is to turn the setting back off.
async function approvalRequired(deps: Deps): Promise<boolean> {
  const cfg = await getSettingValue<{ enabled?: boolean }>(deps, "access-approval", {});
  return cfg.enabled === true;
}

// What the rule GRANTS, in words - the one sentence builder for every notification and audit line the
// server writes about a rule ("write access to their department's leave requests"). The web UI has its own
// richer renderer (collectionMeta + verbMeta); this is the plain-language server-side equivalent.
export function ruleSentence(r: { collection: string; scope: string; field?: string; level?: string; verb?: string; effect: string }): string {
  const nouns = r.collection.replace(/-/g, " ");
  const where = r.scope === "self" ? `their own ${nouns}` : r.scope === "dept" ? `their department's ${nouns}` : r.scope === "exact" || r.scope === "subtree" ? `one ${nouns} record` : nouns;
  const what = r.verb ? `the "${r.verb}" action on ${where}` : r.scope === "create" ? `creating ${nouns}` : `${r.level ?? "read"} access to ${where}${r.field ? ` (field "${r.field}")` : ""}`;
  return r.effect === "deny" ? `no ${what}` : what;
}

// Audit meta for a rule event: enough to read the trail WITHOUT joining back to a row that may already be
// deleted (the access-change feed + the modal's "who added this rule" both read these fields), and enough
// for a free-text `q` search on the collection name to find every change that touched it.
const ruleMeta = (row: typeof schema.accessRules.$inferSelect, extra?: Record<string, unknown>) => ({
  rule_id: row.uuid, // access-rules is not a code-bearing collection, so the trail carries the id in meta
  subject_kind: row.subjectKind,
  subject: row.subject,
  collection: row.namespace,
  pattern: row.pattern,
  scope: row.scopeKind,
  ...(row.level ? { level: row.level } : {}),
  effect: row.effect,
  status: row.status,
  ...(row.expiresAt ? { expire_time: new Date(row.expiresAt).toISOString() } : {}),
  ...extra,
});

// Employees affected by a rule: the subject themself for a user rule, every active holder of the role for a
// role rule (capped - a broad `everyone` grant must not fan out a notification to the whole company).
const MAX_GRANT_NOTIFY = 50;
async function affectedEmployeeIds(deps: Deps, subjectKind: "role" | "user", subject: string): Promise<string[]> {
  const rows =
    subjectKind === "user"
      ? await deps.db.select({ emp: schema.users.employeeId }).from(schema.users).where(and(eq(schema.users.uuid, subject), isNotNull(schema.users.employeeId)))
      : await deps.db
          .select({ emp: schema.users.employeeId })
          .from(schema.users)
          .where(and(eq(schema.users.role, subject), eq(schema.users.status, "active"), isNotNull(schema.users.employeeId)))
          .limit(MAX_GRANT_NOTIFY);
  return [...new Set(rows.map((r) => r.emp!))];
}

// Tell people when they GAIN access. A grant that nobody knows about is a grant nobody uses - the rail
// already exists, so a new allow announces itself ("You can now approve leave requests"). Allows only:
// denies and removals are not something to congratulate anyone about, and the `everyone` pseudo-role is
// skipped (it would notify the whole company on every org-wide grant). Best-effort - never fails the write.
async function notifyGranted(deps: Deps, actor: AppUser, row: typeof schema.accessRules.$inferSelect, r: AccessRuleInput): Promise<void> {
  if (row.effect !== "allow" || row.status !== "active" || r.subject === EVERYONE_ROLE) return;
  const empIds = (await affectedEmployeeIds(deps, row.subjectKind, row.subject)).filter((e) => e !== actor.employeeId);
  if (!empIds.length) return;
  const sentence = ruleSentence({ collection: row.namespace, scope: r.scope, field: r.field, level: row.level ?? undefined, verb: r.verb, effect: row.effect });
  await notifyMany(deps, empIds, {
    type: "access.granted",
    title: "You have new access",
    body: `You now have ${sentence}.${row.expiresAt ? ` It expires on ${new Date(row.expiresAt).toISOString().slice(0, 10)}.` : ""}`,
    link: `#/${row.namespace}`,
    actorId: actor.employeeId,
  });
}

// Tell the access admins that a change is waiting for a second pair of eyes.
async function notifyPending(deps: Deps, actor: AppUser, row: typeof schema.accessRules.$inferSelect, verb: "grant" | "removal"): Promise<void> {
  const empIds = await accessAdminEmployeeIds(deps, actor.employeeId);
  if (!empIds.length) return;
  await notifyMany(deps, empIds, {
    type: "access.changePending",
    title: "A permission change needs approval",
    body: `${actor.name || actor.email} requested the ${verb} of ${ruleSentence({ collection: row.namespace, scope: row.scopeKind, level: row.level ?? undefined, effect: row.effect })} for ${row.subjectKind === "role" ? `the ${row.subject} role` : "a person"}. Someone else has to approve it.`,
    link: "#/settings/permissions",
    actorId: actor.employeeId,
  });
}

// One rule, serialized. Only for the collection-level :approve / :reject methods, which are their own routes and
// answer with the rule they decided; the collection's own paths get this from the factory (decorate + serialize).
async function serializeRule(deps: Deps, row: typeof schema.accessRules.$inferSelect) {
  const [r] = await withObjectRefs(deps, [row]);
  return toAccessRuleResource(r!, r!._objectUuid);
}

// A per-object rule stores the object's CODE (the matching key); the wire carries its id. Resolving that is the
// collection's `decorate`, so it happens once per page on whichever path answers - and only for the exact-scope
// rows that have an object at all.
export async function withObjectRefs(deps: Deps, rows: (typeof schema.accessRules.$inferSelect)[]) {
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      _objectUuid: r.scopeKind === "exact" && r.matchCode ? await codeToUuid(deps, r.namespace, r.matchCode) : null,
    })),
  );
}

export async function createAccessRule(deps: Deps, actor: AppUser, body: unknown) {
  const r = validateAccessRule(body, actor.policy, deps.clock.now());

  // Resolve + guard the subject.
  let subject: string;
  if (r.subjectKind === "user") {
    subject = r.subject.slice("users/".length);
    if (!(await deps.db.select({ u: schema.users.uuid }).from(schema.users).where(eq(schema.users.uuid, subject)).limit(1))[0]) throw notFound("subject user not found");
  } else {
    subject = r.subject;
    if (!(await deps.db.select({ n: schema.roles.name }).from(schema.roles).where(eq(schema.roles.name, subject)).limit(1))[0]) throw notFound("subject role not found");
    if (subject === actor.role) throw failedPrecondition("cannot edit rules of the role you are using");
  }

  const pattern = await buildPattern(deps, r);
  const n = deriveNarrowing(pattern);
  const values = {
    subject,
    subjectKind: r.subjectKind,
    namespace: n.namespace,
    pattern,
    scopeKind: n.scopeKind,
    scopeCode: n.scopeCode,
    matchCode: n.scopeKind === "exact" ? n.scopeCode : null,
    level: r.level ?? null, // null for verb rules and denies (validator guarantees)
    effect: r.effect,
    status: (await approvalRequired(deps)) ? ("pending" as const) : ("active" as const),
    requestedBy: actor.uuid,
    expiresAt: r.expiresAt ?? null,
  };

  // Dedup at row grain (no new DB index - keep the read query plan untouched): the same (subject, pattern,
  // effect) is a duplicate. Editing a level = delete the old rule then create the new one.
  const dup = (
    await deps.db
      .select({ id: schema.accessRules.uuid })
      .from(schema.accessRules)
      .where(and(eq(schema.accessRules.subject, subject), eq(schema.accessRules.subjectKind, r.subjectKind), eq(schema.accessRules.pattern, pattern), eq(schema.accessRules.effect, r.effect)))
      .limit(1)
  )[0];
  if (dup) throw alreadyExists("an identical access rule already exists");

  const [row] = await deps.db.insert(schema.accessRules).values(values).returning();
  bustGrantCache(r.subjectKind, subject); // bust the cached broad grant
  await audit(deps, actor, values.status === "pending" ? "access-rule.request" : "access-rule.create", "access-rules", row!.uuid, ruleMeta(row!, { sentence: ruleSentence({ ...r, level: r.level, effect: r.effect }) }));
  if (values.status === "pending") await notifyPending(deps, actor, row!, "grant").catch(() => {});
  else await notifyGranted(deps, actor, row!, r).catch(() => {});
  return row!;
}

export async function deleteAccessRule(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.accessRules).where(ruleById(id)).limit(1))[0];
  if (!row) throw notFound("access rule not found");
  if (row.subjectKind === "role" && row.subject === actor.role) throw failedPrecondition("cannot edit rules of the role you are using");
  // Under four-eyes, removing an ACTIVE rule is itself a change to be approved: the row is MARKED
  // `pending_delete` and keeps enforcing (policyLoad `live` still loads it) until a second admin approves.
  // Marking rather than deleting is what makes the removal reviewable, reversible, and non-surprising.
  // A row that is ALREADY pending is a request, not authority: withdrawing it needs no second approval.
  if (row.status === "active" && (await approvalRequired(deps))) {
    await deps.db.update(schema.accessRules).set({ status: "pending_delete", requestedBy: actor.uuid, updatedAt: deps.clock.now() }).where(ruleById(id));
    bustGrantCache(row.subjectKind, row.subject);
    await audit(deps, actor, "access-rule.removalRequest", "access-rules", id, ruleMeta(row));
    await notifyPending(deps, actor, row, "removal").catch(() => {});
    return;
  }
  await deps.db.delete(schema.accessRules).where(ruleById(id));
  bustGrantCache(row.subjectKind, row.subject);
  await audit(deps, actor, "access-rule.delete", "access-rules", id, ruleMeta(row));
}

// Four-eyes decision on a pending change. `approve` applies it (a pending grant goes live; a pending removal
// deletes the row); `reject` puts things back (a pending grant is dropped; a pending removal is restored).
// The requester may not decide their own request - that is the entire point of the setting - but they can
// always DELETE their own pending row to withdraw it.
export async function decideAccessRule(deps: Deps, actor: AppUser, id: string, decision: "approve" | "reject") {
  const row = (await deps.db.select().from(schema.accessRules).where(ruleById(id)).limit(1))[0];
  if (!row) throw notFound("access rule not found");
  if (row.status === "active") throw failedPrecondition("this access rule is not awaiting a decision");
  if (row.requestedBy && row.requestedBy === actor.uuid) throw failedPrecondition("a permission change must be approved by someone other than the person who requested it");
  if (row.subjectKind === "role" && row.subject === actor.role) throw failedPrecondition("cannot edit rules of the role you are using");

  const applying = decision === "approve";
  const removing = row.status === "pending_delete";
  if ((applying && removing) || (!applying && !removing)) {
    // approve a removal -> the row goes; reject a grant -> the request goes. Either way nothing is left behind.
    await deps.db.delete(schema.accessRules).where(ruleById(id));
  } else {
    await deps.db.update(schema.accessRules).set({ status: "active", requestedBy: null, updatedAt: deps.clock.now() }).where(ruleById(id));
  }
  bustGrantCache(row.subjectKind, row.subject);
  await audit(deps, actor, `access-rule.${decision}`, "access-rules", id, ruleMeta(row, { requested_by: row.requestedBy }));

  // Tell the requester what happened, and - for an approved grant - tell whoever just gained the access.
  const requester = row.requestedBy ? (await deps.db.select({ emp: schema.users.employeeId }).from(schema.users).where(eq(schema.users.uuid, row.requestedBy)).limit(1))[0]?.emp : null;
  const sentence = ruleSentence({ collection: row.namespace, scope: row.scopeKind, level: row.level ?? undefined, effect: row.effect });
  if (requester && requester !== actor.employeeId) {
    await notifyMany(deps, [requester], {
      type: "access.changeDecided",
      title: `Permission change ${applying ? "approved" : "rejected"}`,
      body: `${actor.name || actor.email} ${applying ? "approved" : "rejected"} your requested ${removing ? "removal" : "grant"} of ${sentence}.`,
      link: "#/settings/permissions",
      actorId: actor.employeeId,
    }).catch(() => {});
  }
  if (applying && !removing) {
    const r: AccessRuleInput = { subjectKind: row.subjectKind, subject: row.subject, collection: row.namespace, scope: row.scopeKind, level: row.level ?? undefined, effect: row.effect };
    await notifyGranted(deps, actor, { ...row, status: "active" }, r).catch(() => {});
  }
  return serializeRule(deps, (await deps.db.select().from(schema.accessRules).where(ruleById(id)).limit(1))[0] ?? { ...row, status: applying && !removing ? "active" : row.status });
}

// Resolve the `{ rule }` body ref of the collection-level :approve / :reject methods to a rule id.
export function ruleIdFromRef(ref: unknown): string {
  const s = typeof ref === "string" ? ref : "";
  const id = s.startsWith("access-rules/") ? s.slice("access-rules/".length) : s;
  if (!id) throw invalidArgument("rule is required as access-rules/{id}");
  return id;
}

// Nightly hygiene: drop rules whose expiry has passed. They already stopped deciding the moment they lapsed
// (policyLoad filters on the same instant), so this only keeps the table - and the UI's rule lists - clean.
export async function purgeExpiredAccessRules(deps: Deps): Promise<number> {
  const now = deps.clock.now();
  // The WHOLE row, not just the id: these are hard-deleted below, so whatever the trail does not record about
  // them is gone. "Who lost which access, when, and under what rule" is the question this table exists for.
  const expired = await deps.db
    .select()
    .from(schema.accessRules)
    .where(and(isNotNull(schema.accessRules.expiresAt), lte(schema.accessRules.expiresAt, now)));
  if (!expired.length) return 0;
  await deps.db.delete(schema.accessRules).where(inArray(schema.accessRules.uuid, expired.map((r) => r.uuid)));
  for (const r of expired) bustGrantCache(r.subjectKind, r.subject);
  // One entry per LAPSED RULE, batched. A nightly `{ expired: 4 }` said that four people somewhere lost
  // something - which is exactly the shape of audit entry nobody can act on. Each entry now names the subject,
  // the collection and the pattern, the same `ruleMeta` a grant or a revocation records, so an expiry reads
  // like the revocation it is and the access-change feed can show all three side by side.
  await auditMany(deps, "system", expired.map((row) => ({
    action: "access-rule.expire",
    entity: "access-rules",
    entityId: row.uuid,
    // `ruleMeta` alone: it already carries subject, collection, pattern, scope and level. The plain-language
    // sentence the create path adds is built from the WIRE shape (`collection`/`scope`), not the row's
    // (`namespace`/`scopeKind`), so it does not belong on this side of the boundary.
    meta: ruleMeta(row),
    snapshot: row,
  })));
  return expired.length;
}
