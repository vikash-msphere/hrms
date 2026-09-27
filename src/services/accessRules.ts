// The ONE access-rule management service - roles and users, identical mechanism. Each rule is a row in
// access_rules (the sole source of record); the service builds the verbatim pattern ONCE from the structured
// input, then reuses `deriveNarrowing` to fill the narrowing columns and sets match_code for exact rules -
// byte-identical to what the seed's `compileGrant` produces, so a created row is indistinguishable from a
// seeded one and the engine + BOLA oracles never change. No grant blob, no recompile. Super-only via the
// `access-rules` collection key (the middleware gates it).
import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, auditMany } from "../lib/audit";
import { byIdChunks } from "../lib/dbBatch";
import { clearCache, clearCachePrefix } from "../lib/cache";
import { notFound, failedPrecondition, alreadyExists, invalidArgument, forbidden } from "../lib/errors";
import { ruleWithinAuthority } from "../domain/access";
import { validateAccessRule, type AccessRuleInput } from "../domain/policyValidate";
import { deriveNarrowing } from "../domain/compileGrants";
import { EVERYONE_ROLE, isSuperGrant } from "../domain/grants";
import { uuidToCode, codeToUuid } from "../lib/authzResolve";
import { genId } from "../lib/idCodec";
import { getSettingValue, upsertSetting } from "./settings";
import { systemActor } from "../lib/systemActor";
import { accessAdminEmployeeIds } from "./accessRequest";
import { notifyMany } from "./notifications";
import { toAccessRuleResource, parseRulePattern } from "../http/serialize";

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
  // The manager chain, subject-relative like the two above: the token carries no code, and who it reaches is
  // resolved per caller when the decision is made (domain/permissions.ts matchToken).
  else if (r.scope === "reports") idToken = "my-reports";
  else if (r.scope === "org") idToken = "my-org";
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

/**
 * Every role a caller's authority is actually assembled from, not just the one they are labelled with.
 *
 * `role` is the PRIMARY role and the one the audit trail records; `roles` is the whole set, and
 * middleware/auth.ts merges a grant for each of them (`loadAuthority`: the primary, plus every secondary from
 * `user_roles`, plus the caller's own user rules). Anything deciding "does this feed my own grant" has to ask
 * about the set - `role` alone answers a narrower question than the one being asked.
 *
 * Falls back to the primary for a principal assembled outside the auth middleware (the system actor, a test
 * fixture), which is the same set by construction when there are no secondary roles.
 */
const rolesHeldBy = (actor: AppUser): readonly string[] => (actor.roles?.length ? actor.roles : [actor.role]);

/**
 * NOBODY AUTHORS THEIR OWN AUTHORITY. Refused for every subject that feeds the author's own grant.
 *
 * middleware/auth.ts assembles a caller's authority from FOUR kinds of subject, not one - lib/policyLoad.ts
 * merges the caller's user rows over `mergeGrants(everyone rows, own-role rows)`, and `loadAuthority` merges a
 * grant for EVERY role they hold, not only the primary one. So "cannot edit rules of the role you are using"
 * was one quarter of the guard: an ACL admin could still author a broad rule against their OWN user row,
 * against `everyone` (which is unioned into every non-super caller's grant), or against a SECONDARY role of
 * theirs - and hold whatever it granted from the next request onward. One rule per collection is all it takes
 * to reach `compensation`, `payslips` or `audit` at admin - precisely the collections the seeded policy keeps
 * a delegated admin out of.
 *
 * THE SECONDARY-ROLE HOLE IS THE ONE THIS COMMENT USED TO DESCRIBE ITSELF AS CLOSING. Secondary roles arrived
 * after the guard did, the check kept comparing against `actor.role`, and the paragraph above went on claiming
 * every subject was covered. `AppUser.roles` says what the set is for in its own comment - "a rule written for
 * somebody's second role silently stops applying to them" - which is the same sentence read the other way
 * round: a rule written for your own second role silently starts applying to you.
 *
 * Latent while `access-rules` has no seeded grant (only super holds it, and super already has `**`), but
 * delegating access management is the feature: `useCanManageAccess()` and the four-eyes queue exist so that
 * more than one person administers permissions. The queue is also no backstop here - `access-approval` is
 * opt-in and absent by default, so an unapproved rule lands `active` on the spot.
 *
 * Super is exempt only for `everyone`: a super author cannot widen themselves with it (they already hold
 * `**`), and org-wide rules are a normal super action - the seeded `everyone` grants are exactly that shape.
 * The self-subject guards apply to everyone, super included, because writing a rule for a role or the user
 * you are signed in as is never the way to change your own access.
 */
function assertNotSelfWidening(actor: AppUser, subjectKind: "role" | "user", subject: string): void {
  if (subjectKind === "user") {
    if (subject === actor.uuid) throw failedPrecondition("cannot write rules for your own user - ask another access admin");
    return;
  }
  if (rolesHeldBy(actor).includes(subject)) {
    // Named, because "the role you are using" reads as the one on your profile and the refusal is now about
    // any of them: somebody holding a second role has to be told which rule they cannot write.
    throw failedPrecondition(`cannot edit rules of "${subject}" - you hold that role, so ask another access admin`);
  }
  if (subject === EVERYONE_ROLE && !isSuperGrant(actor.grant)) {
    throw failedPrecondition("the 'everyone' role includes you, so its rules are super-admin only");
  }
}

/**
 * AND NOBODY AUTHORS MORE THAN THEY HOLD. The self-widening guard above covers the author's own subjects; this
 * covers everyone else's. Without it an access admin could write `compensation.**: admin` for a role they do
 * not hold, or clone super's rules onto one, which is delegating super by proxy. Super is exempt: `**` covers
 * everything, so the check would only cost it a walk. Clone and the four-eyes approve inherit it - clone
 * creates through `createAccessRule`, and approving a pending rule is authoring it a second time.
 */
function assertWithinAuthority(actor: AppUser, rule: { pattern: string; level: "read" | "write" | "admin" | null; effect: string }): void {
  if (rule.effect !== "allow" || isSuperGrant(actor.grant)) return;
  if (!ruleWithinAuthority(actor, rule)) {
    throw forbidden(`you can only grant access you hold yourself - "${rule.pattern}"${rule.level ? ` at ${rule.level}` : ""} is beyond your own`);
  }
}

// What the rule GRANTS, in words - the one sentence builder for every notification and audit line the
// server writes about a rule ("write access to their department's leave requests"). The web UI has its own
// richer renderer (collectionMeta + verbMeta); this is the plain-language server-side equivalent.
export function ruleSentence(r: { collection: string; scope: string; scopeRef?: string; field?: string; level?: string; verb?: string; effect: string }): string {
  const nouns = r.collection.replace(/-/g, " ");
  // A subtree anchored to a DEPARTMENT is the named-department tier - one department's rows, not one record -
  // and the trail is where somebody checks which. Callers that do not resolve the anchor omit `scopeRef` and
  // get the record wording, which is right for `exact` and no worse than before for the rest.
  const anchored = r.scopeRef?.startsWith("departments/") ? `one department's ${nouns}` : `one ${nouns} record`;
  // The manager chain says WHOSE rows as much as `self` and `dept` do, and without these two a chain rule read
  // as the bare plural - which is the phrase an ORG-WIDE rule gets. In an audit trail that is the difference
  // between "read their reports' payslips" and "read payslips", written about the same grant.
  const where =
    r.scope === "self" ? `their own ${nouns}`
    : r.scope === "dept" ? `their department's ${nouns}`
    : r.scope === "reports" ? `their reports' ${nouns}`
    : r.scope === "org" ? `their reporting line's ${nouns}`
    : r.scope === "exact" || r.scope === "subtree" ? anchored
    : nouns;
  const what = r.verb ? `the "${r.verb}" action on ${where}` : r.scope === "create" ? `creating ${nouns}` : `${r.level ?? "read"} access to ${where}${r.field ? ` (field "${r.field}")` : ""}`;
  return r.effect === "deny" ? `no ${what}` : what;
}

// Audit meta for a rule event: enough to read the trail WITHOUT joining back to a row that may already be
// deleted (the access-change feed + the modal's "who added this rule" both read these fields), and enough
// for a free-text `q` search on the collection name to find every change that touched it.
type RuleRow = typeof schema.accessRules.$inferSelect;

// Who a rule is ABOUT, in words, for every rule the trail is about to record - resolved in ONE read.
//
// A role rule needs no read: the stored subject IS the role name. A USER rule stores a users uuid, which is the
// one fact in a permission entry a reader can do nothing with - and the row is hard-deleted on the delete,
// reject and expiry paths, so the trail is the only place left to look it up. Both the email and the employee
// ref go in: the feed resolves the ref to a person's name and falls back to the email when it cannot.
type Subject = { subjectKind: "role" | "user"; subject: string };
async function subjectWords(deps: Deps, rows: Subject[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (r.subjectKind === "role") out.set(`role:${r.subject}`, { subject_label: r.subject === EVERYONE_ROLE ? "everyone" : `the ${r.subject} role` });
  }
  const uuids = [...new Set(rows.filter((r) => r.subjectKind === "user").map((r) => r.subject))];
  if (uuids.length) {
    // Chunked for the same reason the purge above is: this is called with a whole batch of rules (a page of
    // them, or every rule lapsing on one night), and each distinct user subject binds a parameter.
    const users = await byIdChunks(uuids, (group) =>
      deps.db
        .select({ uuid: schema.users.uuid, email: schema.users.email, emp: schema.users.employeeId })
        .from(schema.users)
        .where(inArray(schema.users.uuid, group)),
    );
    for (const u of users) out.set(`user:${u.uuid}`, { subject_label: u.email, ...(u.emp ? { subject_employee: `employees/${u.emp}` } : {}) });
  }
  return out;
}
const subjectKey = (row: Subject) => `${row.subjectKind}:${row.subject}`;
/** The subject words for ONE rule (single-rule paths); a rule write is a rare admin action, so one read is fine. */
const subjectExtra = async (deps: Deps, row: RuleRow) => (await subjectWords(deps, [row])).get(subjectKey(row)) ?? {};

// The authoring facts of a stored rule: the scope as AUTHORED (the create gate is a 1-token pattern, not a
// scope column) plus the verb / field that only exist inside the pattern. Same parser as the wire resource.
const ruleFacts = (row: RuleRow) => {
  const p = parseRulePattern(row.pattern, row.level);
  return { scope: p.createGate ? "create" : row.scopeKind, verb: p.verb, field: p.field };
};

const ruleMeta = (row: RuleRow, extra?: Record<string, unknown>) => {
  const f = ruleFacts(row);
  return {
    rule_id: row.uuid, // access-rules is not a code-bearing collection, so the trail carries the id in meta
    subject_kind: row.subjectKind,
    // A user subject is stored as a bare users uuid; the trail carries it as a REF, the way the resource
    // serializer does, so no internal id reaches the wire and the reader's client can resolve it.
    subject: row.subjectKind === "user" ? `users/${row.subject}` : row.subject,
    collection: row.namespace,
    pattern: row.pattern,
    scope: f.scope,
    ...(f.verb ? { verb: f.verb } : {}),
    ...(f.field ? { field: f.field } : {}),
    ...(row.level ? { level: row.level } : {}),
    effect: row.effect,
    status: row.status,
    ...(row.expiresAt ? { expire_time: new Date(row.expiresAt).toISOString() } : {}),
    // The plain-language sentence on EVERY rule event, not just the create. A rule change has no field diff, so
    // the sentence is the whole of what happened; without it a revocation, a four-eyes decision and an expiry
    // each rendered as an actor, a verb and a bare id - a trail nobody could read or act on.
    sentence: ruleSentence({ collection: row.namespace, scope: f.scope, field: f.field, level: row.level ?? undefined, verb: f.verb, effect: row.effect }),
    ...extra,
  };
};

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
  const sentence = ruleSentence({ collection: row.namespace, scope: r.scope, scopeRef: r.scopeRef, field: r.field, level: row.level ?? undefined, verb: r.verb, effect: row.effect });
  await notifyMany(deps, empIds, {
    type: "access.granted",
    title: "You have new access",
    body: `You now have ${sentence}.${row.expiresAt ? ` It expires on ${new Date(row.expiresAt).toISOString().slice(0, 10)}.` : ""}`,
    link: row.namespace,
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
    link: "settings/permissions",
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
    rows.map(async (r) => {
      if (r.scopeKind === "exact" && r.matchCode) {
        return { ...r, _objectUuid: await codeToUuid(deps, r.namespace, r.matchCode), _objectCollection: r.namespace };
      }
      if (r.scopeKind === "subtree" && r.scopeCode) {
        const anchor = await resolveAnchor(deps, r.namespace, r.scopeCode);
        return { ...r, _objectUuid: anchor?.uuid ?? null, _objectCollection: anchor?.collection ?? null };
      }
      return { ...r, _objectUuid: null, _objectCollection: null };
    }),
  );
}

/**
 * The object a SUBTREE rule is anchored to, from the code prefix the rule stores.
 *
 * A subtree rule keeps only the prefix (`scope_code`) - the decision input - so the anchor's collection is
 * not written down anywhere, and it cannot be assumed to be the rule's own: granting one department's leave
 * requests stores a `departments` code on a `leave-requests` rule. Rather than add a column for a fact that
 * is only ever needed to draw a name on an admin screen, it is recovered here, and the recovery is total
 * because only two collections produce codes that anything else nests under: `departments` (the hierarchy)
 * and `employees` (owned rows hang off an employee). Anchoring to anything else composes a prefix nothing is
 * coded under, which the validator refuses outright.
 *
 * The rule's own namespace is tried first so a same-collection anchor (a departments subtree) costs one read
 * and never risks matching a coincidentally equal code in another table.
 */
async function resolveAnchor(deps: Deps, namespace: string, code: string): Promise<{ collection: string; uuid: string } | null> {
  for (const collection of [...new Set([namespace, "departments", "employees"])]) {
    const uuid = await codeToUuid(deps, collection, code);
    if (uuid) return { collection, uuid };
  }
  return null;
}

/**
 * `quiet` suppresses this rule's OWN notification. Only the clone below passes it: forty rules copied in one
 * act is one thing that happened, and forty "You have new access" cards is a worse way to learn about it than
 * the single summary the clone sends instead. The audit entry is never suppressed.
 */
export async function createAccessRule(deps: Deps, actor: AppUser, body: unknown, opts: { quiet?: boolean } = {}) {
  const r = validateAccessRule(body, actor.policy, deps.clock.now());

  // Resolve + guard the subject. See assertNotSelfWidening for why all three subject kinds are checked.
  let subject: string;
  if (r.subjectKind === "user") {
    subject = r.subject.slice("users/".length);
    if (!(await deps.db.select({ u: schema.users.uuid }).from(schema.users).where(eq(schema.users.uuid, subject)).limit(1))[0]) throw notFound("subject user not found");
  } else {
    subject = r.subject;
    if (!(await deps.db.select({ n: schema.roles.name }).from(schema.roles).where(eq(schema.roles.name, subject)).limit(1))[0]) throw notFound("subject role not found");
  }
  assertNotSelfWidening(actor, r.subjectKind, subject);

  const pattern = await buildPattern(deps, r);
  // Nobody hands out more than they hold (domain/access.ts ruleWithinAuthority). A deny only subtracts.
  assertWithinAuthority(actor, { pattern, level: r.level ?? null, effect: r.effect });
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
    // The threshold, stored as JSON beside the pattern rather than compiled into it - see db/schema.ts.
    condition: r.condition ? JSON.stringify(r.condition) : null,
    fromIp: r.fromIp ?? null,
    window: r.window ? JSON.stringify(r.window) : null,
    source: "acl" as const, // authored by a person here; services/ticketShares.ts owns the "ticket-share" rows
  };

  // Dedup at row grain (no new DB index - keep the read query plan untouched): the same (subject, pattern,
  // effect) is a duplicate. Editing a level = delete the old rule then create the new one.
  //
  // Scoped to the AUTHORED rows. A ticket share is byte-identical to a `scope:exact, level:read` user rule, so
  // without `source` in the predicate an automatic share on a ticket would refuse an admin's own grant on it
  // (and the share's revoke would then take the admin's away) - the two rows are separate things that happen
  // to spell the same permission.
  const dup = (
    await deps.db
      .select({ id: schema.accessRules.uuid })
      .from(schema.accessRules)
      .where(and(eq(schema.accessRules.subject, subject), eq(schema.accessRules.subjectKind, r.subjectKind), eq(schema.accessRules.pattern, pattern), eq(schema.accessRules.effect, r.effect), eq(schema.accessRules.source, "acl"), r.condition ? eq(schema.accessRules.condition, JSON.stringify(r.condition)) : isNull(schema.accessRules.condition)))
      .limit(1)
  )[0];
  if (dup) throw alreadyExists("an identical access rule already exists");

  const [row] = await deps.db.insert(schema.accessRules).values(values).returning();
  bustGrantCache(r.subjectKind, subject); // bust the cached broad grant
  await audit(deps, actor, values.status === "pending" ? "access-rule.request" : "access-rule.create", "access-rules", row!.uuid, ruleMeta(row!, await subjectExtra(deps, row!)), row!);
  if (opts.quiet) return row!;
  if (values.status === "pending") await notifyPending(deps, actor, row!, "grant").catch(() => {});
  else await notifyGranted(deps, actor, row!, r).catch(() => {});
  return row!;
}

/** A clone that copies more rules than this is a mistake with a bigger blast radius than a request should have. */
const MAX_CLONE_RULES = 200;

// One subject spec off the wire: `{ subject_kind, subject }`, the same pair every rule body carries (a user
// subject arrives as `users/<id>`, already wire-decoded by the inbound edge).
function parseSubjectSpec(v: unknown, side: "from" | "to"): Subject {
  const o = (v ?? {}) as { subject_kind?: unknown; subject?: unknown };
  const kind = o.subject_kind;
  if (kind !== "role" && kind !== "user") throw invalidArgument(`${side}.subject_kind must be "role" or "user"`);
  if (typeof o.subject !== "string" || !o.subject) throw invalidArgument(`${side}.subject is required`);
  return { subjectKind: kind, subject: kind === "user" ? o.subject.replace(/^users\//, "") : o.subject };
}

/**
 * Copy every rule one subject holds onto another, as ONE act.
 *
 * Each rule still goes through `createAccessRule` - same validation, same four-eyes queue, same per-rule audit
 * entry - because a bulk path with its own write logic is a second policy engine waiting to disagree with the
 * first. What this adds is that the whole copy is ONE traceable operation: it parks a correlation id on Deps
 * before the first create, so every entry the copy writes carries it (`audit_log.correlation_id`) and the
 * activity feed's act view replays the copy as the single change it was, not as forty unrelated grants. The
 * client loop it replaces could not do that - forty requests are forty acts, with nothing tying them together.
 *
 * Additive, like the rest of the access model: nothing on the target is removed. A rule the target already
 * holds comes back as a conflict and is counted `skipped` rather than failing the copy, so copying twice is
 * safe; anything the policy refuses outright is counted `failed` and named, rather than silently dropped.
 */
export async function cloneAccessRules(deps: Deps, actor: AppUser, body: unknown): Promise<{ added: number; skipped: number; failed: number; source_total: number; correlation_id: string; first_error?: string }> {
  const b = (body ?? {}) as { from?: unknown; to?: unknown };
  const from = parseSubjectSpec(b.from, "from");
  const to = parseSubjectSpec(b.to, "to");
  if (from.subjectKind === to.subjectKind && from.subject === to.subject) throw invalidArgument("from and to must be different subjects");
  // Guard the TARGET here, not just inside the per-rule create: a bad target is one error about the copy, not
  // forty identical errors counted as forty failures.
  if (to.subjectKind === "user") {
    if (!(await deps.db.select({ u: schema.users.uuid }).from(schema.users).where(eq(schema.users.uuid, to.subject)).limit(1))[0]) throw notFound("target user not found");
  } else {
    if (!(await deps.db.select({ n: schema.roles.name }).from(schema.roles).where(eq(schema.roles.name, to.subject)).limit(1))[0]) throw notFound("target role not found");
  }
  // Same three-subject guard the per-rule create applies (assertNotSelfWidening): copying forty rules onto
  // yourself, or onto `everyone`, widens the author exactly as authoring one does.
  assertNotSelfWidening(actor, to.subjectKind, to.subject);

  // ACTIVE rules only. A `pending` row is a request nobody has approved and a `pending_delete` one is on its
  // way out - copying either would forward a decision that has not been made.
  const source = await deps.db
    .select()
    .from(schema.accessRules)
    .where(and(eq(schema.accessRules.subject, from.subject), eq(schema.accessRules.subjectKind, from.subjectKind), eq(schema.accessRules.status, "active")));
  if (source.length > MAX_CLONE_RULES) throw failedPrecondition(`that subject holds ${source.length} rules; copy at most ${MAX_CLONE_RULES} at a time`);

  // The correlation id for the whole copy, parked on Deps BEFORE the first write so every audit entry (and any
  // event the writes emit) records it. Reuses the trace already running if this copy is itself part of one.
  deps.trace ??= genId();
  const correlationId = deps.trace;

  const rows = await withObjectRefs(deps, source);
  let added = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: string | undefined;
  let pending = 0;
  for (const r of rows) {
    // Rebuild the rule as its own create body - the wire shape is the ONE input `createAccessRule` validates,
    // so a copied rule is authored exactly as a hand-written one (and a rule the pattern cannot round-trip
    // fails here rather than landing subtly different from its source).
    const w = toAccessRuleResource(r, r._objectUuid);
    const input = {
      subject_kind: to.subjectKind,
      subject: to.subjectKind === "user" ? `users/${to.subject}` : to.subject,
      collection: w.collection,
      scope: w.scope,
      ...(w.scope_ref ? { scope_ref: w.scope_ref } : {}),
      ...(w.field ? { field: w.field } : {}),
      ...(w.verb ? { verb: w.verb } : w.level ? { level: w.level } : {}),
      ...(w.effect === "deny" ? { effect: "deny" } : {}),
      ...(w.expire_time ? { expire_time: w.expire_time } : {}),
    };
    try {
      const created = await createAccessRule(deps, actor, input, { quiet: true });
      added++;
      if (created.status !== "active") pending++;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      // Already there is the expected outcome of copying twice, and of "same as HR, plus payroll". A lapsed
      // expiry or a rule the target's kind cannot hold is a real refusal, and gets named.
      if (/already exists/i.test(msg)) skipped++;
      else {
        failed++;
        firstError ??= msg;
      }
    }
  }

  const labels = await subjectWords(deps, [from, to]);
  const fromWords = labels.get(subjectKey(from)) ?? {};
  const toWords = labels.get(subjectKey(to)) ?? {};
  // The summary entry: the copy itself, as one row in the trail. The per-rule entries under the same
  // correlation id say WHICH rules; this one says it was a copy, from whom, and what landed.
  await audit(deps, actor, "access-rule.clone", "access-rules", undefined, {
    from_subject_kind: from.subjectKind,
    from_subject: from.subject,
    from_label: fromWords.subject_label,
    subject_kind: to.subjectKind,
    subject: to.subject,
    ...toWords,
    added,
    skipped,
    failed,
    source_total: source.length,
    sentence: `${added} rule${added === 1 ? "" : "s"} copied from ${String(fromWords.subject_label ?? from.subject)}`,
    ...(firstError ? { first_error: firstError } : {}),
  }, null,
  // The entity NAME, which `q` searches and `meta` is not. Anchored on no row, this entry was the one
  // access-rule entry in the trail with no name at all: an auditor who searched the subject that GAINED the
  // access found each per-rule create and not the copy that authored them - the only row that says it was a
  // copy and where it came from. The subject is the label; there is no single collection here, which is
  // exactly what makes this the summary.
  String(toWords.subject_label ?? to.subject));

  // ONE notification for the whole copy, in place of the per-rule cards the creates would have sent.
  if (added) {
    if (pending) await notifyCloneQueued(deps, actor, added, fromWords.subject_label, toWords.subject_label).catch(() => {});
    else await notifyCloned(deps, actor, to, added, fromWords.subject_label).catch(() => {});
  }
  // `first_error`, not `error`: a plain `error` property on a 200 body reads as an error envelope (the AEP
  // linter refuses it outright), and the copy did not fail - some of its rules did.
  return { added, skipped, failed, source_total: source.length, correlation_id: correlationId, ...(firstError ? { first_error: firstError } : {}) };
}

// "You have new access", once, for a copy. Same rail as a single grant (notifyGranted), same `everyone` guard:
// an org-wide copy must not fan out to the whole company.
async function notifyCloned(deps: Deps, actor: AppUser, to: Subject, added: number, fromLabel: unknown): Promise<void> {
  if (to.subjectKind === "role" && to.subject === EVERYONE_ROLE) return;
  const empIds = (await affectedEmployeeIds(deps, to.subjectKind, to.subject)).filter((e) => e !== actor.employeeId);
  if (!empIds.length) return;
  await notifyMany(deps, empIds, {
    type: "access.granted",
    title: "You have new access",
    body: `${added} permission${added === 1 ? "" : "s"} held by ${String(fromLabel ?? "another subject")} ${added === 1 ? "was" : "were"} copied to you.`,
    link: "settings/permissions",
    actorId: actor.employeeId,
  });
}

// Under four-eyes the copy lands as pending rows: the access admins get one card for the batch, not one each.
async function notifyCloneQueued(deps: Deps, actor: AppUser, added: number, fromLabel: unknown, toLabel: unknown): Promise<void> {
  const empIds = await accessAdminEmployeeIds(deps, actor.employeeId);
  if (!empIds.length) return;
  await notifyMany(deps, empIds, {
    type: "access.changePending",
    title: "A permission change needs approval",
    body: `${actor.name || actor.email} copied ${added} permission${added === 1 ? "" : "s"} from ${String(fromLabel ?? "another subject")} to ${String(toLabel ?? "another subject")}. Someone else has to approve them.`,
    link: "settings/permissions",
    actorId: actor.employeeId,
  });
}

export async function deleteAccessRule(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.accessRules).where(ruleById(id)).limit(1))[0];
  if (!row) throw notFound("access rule not found");
  // EVERY role the caller holds, for the reason `assertNotSelfWidening` gives: a grant merged from a secondary
  // role is as much theirs as one merged from the primary. It matters on this path in both directions -
  // deleting a DENY that sits on a role you hold widens you exactly as adding an allow would.
  if (row.subjectKind === "role" && rolesHeldBy(actor).includes(row.subject)) {
    throw failedPrecondition(`cannot change rules of "${row.subject}" - you hold that role, so ask another access admin`);
  }
  // Under four-eyes, removing an ACTIVE rule is itself a change to be approved: the row is MARKED
  // `pending_delete` and keeps enforcing (policyLoad `live` still loads it) until a second admin approves.
  // Marking rather than deleting is what makes the removal reviewable, reversible, and non-surprising.
  // A row that is ALREADY pending is a request, not authority: withdrawing it needs no second approval.
  if (row.status === "active" && (await approvalRequired(deps))) {
    await deps.db.update(schema.accessRules).set({ status: "pending_delete", requestedBy: actor.uuid, updatedAt: deps.clock.now() }).where(ruleById(id));
    bustGrantCache(row.subjectKind, row.subject);
    await audit(deps, actor, "access-rule.removalRequest", "access-rules", id, ruleMeta(row, await subjectExtra(deps, row)), row);
    await notifyPending(deps, actor, row, "removal").catch(() => {});
    return;
  }
  await deps.db.delete(schema.accessRules).where(ruleById(id));
  bustGrantCache(row.subjectKind, row.subject);
  await audit(deps, actor, "access-rule.delete", "access-rules", id, ruleMeta(row, await subjectExtra(deps, row)), row);
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
  // EVERY role the caller holds, for the reason `assertNotSelfWidening` gives: a grant merged from a secondary
  // role is as much theirs as one merged from the primary. It matters on this path in both directions -
  // deleting a DENY that sits on a role you hold widens you exactly as adding an allow would.
  if (row.subjectKind === "role" && rolesHeldBy(actor).includes(row.subject)) {
    throw failedPrecondition(`cannot change rules of "${row.subject}" - you hold that role, so ask another access admin`);
  }

  const applying = decision === "approve";
  const removing = row.status === "pending_delete";
  // Approving a pending GRANT is authoring it a second time, so the approver is bound the same way the
  // author was: the second pair of hands must be able to give this access themselves.
  if (applying && !removing) assertWithinAuthority(actor, { pattern: row.pattern, level: row.level ?? null, effect: row.effect });
  if ((applying && removing) || (!applying && !removing)) {
    // approve a removal -> the row goes; reject a grant -> the request goes. Either way nothing is left behind.
    await deps.db.delete(schema.accessRules).where(ruleById(id));
  } else {
    await deps.db.update(schema.accessRules).set({ status: "active", requestedBy: null, updatedAt: deps.clock.now() }).where(ruleById(id));
  }
  bustGrantCache(row.subjectKind, row.subject);
  // The requester, resolved once: the trail needs a person (a users uuid in `requested_by` named nobody), and
  // the notification below needs the same employee id.
  const requester = row.requestedBy ? (await deps.db.select({ emp: schema.users.employeeId }).from(schema.users).where(eq(schema.users.uuid, row.requestedBy)).limit(1))[0]?.emp : null;
  await audit(deps, actor, `access-rule.${decision}`, "access-rules", id, ruleMeta(row, {
    ...(await subjectExtra(deps, row)),
    // WHICH pending change was decided: approving a removal and approving a grant are opposite outcomes that
    // otherwise share one action code.
    decided: removing ? "removal" : "grant",
    ...(requester ? { requested_by: `employees/${requester}` } : {}),
  }), row);

  // Tell the requester what happened, and - for an approved grant - tell whoever just gained the access.
  const sentence = ruleSentence({ collection: row.namespace, scope: row.scopeKind, level: row.level ?? undefined, effect: row.effect });
  if (requester && requester !== actor.employeeId) {
    await notifyMany(deps, [requester], {
      type: "access.changeDecided",
      title: `Permission change ${applying ? "approved" : "rejected"}`,
      body: `${actor.name || actor.email} ${applying ? "approved" : "rejected"} your requested ${removing ? "removal" : "grant"} of ${sentence}.`,
      link: "settings/permissions",
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

/**
 * Periodic access recertification: remind the access admins to confirm or revoke the standing privileges.
 *
 * `expires_at` handles access somebody KNEW was temporary. Nothing handled the rest - a grant made for one
 * project, for one person's leave cover, for an audit three quarters ago, stays exactly as it was because
 * removing it is nobody's job on any particular day. That is how an HR system ends up with more payroll
 * writers than it has payroll staff, and no single moment where anyone did anything wrong.
 *
 * Opt-in per org (`access-review` settings blob) and DIGEST-shaped, not a queue: it names the standing
 * privileged rules - permanent, active, write-or-better or a custom method, and not the `everyone` role's
 * self-service - and points at the permissions screen where they are already removable. Deliberately no new
 * "attestation" resource: the decision an admin makes here is to keep a rule or delete it, both of which the
 * existing surface does, audited, and inventing a parallel record of "confirmed on this date" would be a
 * second source of truth about access that nothing enforces.
 *
 * Due-ness is stored on the setting itself, so a skipped tick (a failed cron, a redeploy) simply runs late
 * rather than being missed - the same reasoning as the expiry sweep below being hygiene rather than the
 * enforcement mechanism.
 */
export async function reviewStandingAccess(deps: Deps): Promise<number> {
  const cfg = await getSettingValue<{ enabled?: boolean; every_days?: number; last_run?: string }>(deps, "access-review", {});
  if (cfg.enabled !== true) return 0;
  const everyDays = Number.isFinite(cfg.every_days) && (cfg.every_days as number) > 0 ? Math.round(cfg.every_days as number) : 90;
  const now = deps.clock.now();
  const last = cfg.last_run ? Date.parse(cfg.last_run) : NaN;
  if (Number.isFinite(last) && +now - last < everyDays * 86_400_000) return 0;

  // Standing = permanent and active. A rule with an expiry is already handled, and a pending one is a
  // request nobody has approved, so neither is something to re-confirm.
  const standing = (await deps.db
    .select()
    .from(schema.accessRules)
    .where(and(isNull(schema.accessRules.expiresAt), eq(schema.accessRules.status, "active"))))
    // Privileged only: a read rule is not what an access review is for, and including every one of them
    // would bury the handful that matter under a hundred that do not. `everyone` is excluded for the same
    // reason - it is the org's own self-service baseline, not a grant to a person.
    .filter((r) => r.subject !== EVERYONE_ROLE && (r.level === null || r.level === "write" || r.level === "admin"));

  // Record the run whether or not there is anything to say, so an org with nothing outstanding does not get
  // asked again tomorrow.
  await upsertSetting(deps, await systemActor(deps), "access-review", { ...cfg, last_run: new Date(+now).toISOString() });
  if (!standing.length) return 0;

  const empIds = await accessAdminEmployeeIds(deps);
  if (!empIds.length) return 0;
  const subjects = new Set(standing.map((r) => subjectKey(r))).size;
  await notifyMany(deps, empIds, {
    type: "access.review",
    title: "Time to review standing access",
    body: `${standing.length} permanent rule${standing.length === 1 ? "" : "s"} across ${subjects} role${subjects === 1 ? "" : "s"}/people grant write access or a custom method. Confirm each is still needed, and remove the ones that are not.`,
    link: "settings/permissions",
  });
  await audit(deps, "system", "access-review.due", "access-rules", undefined, { rules: standing.length, subjects, every_days: everyDays });
  return standing.length;
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
  // Chunked: how many rules lapse on one night is set by whoever granted them, not by anything this loop
  // controls - a bulk time-boxed grant (a clone, an audit window, a project's access all dated the same day)
  // lapses together, and one `IN` list of them binds a parameter each. Past a hundred the DELETE answered
  // `D1_ERROR: too many SQL variables` and the whole subtask failed, so nothing was purged and the audit
  // entries below were never written either.
  await byIdChunks(expired.map((r) => r.uuid), (group) =>
    deps.db.delete(schema.accessRules).where(inArray(schema.accessRules.uuid, group)).returning({ uuid: schema.accessRules.uuid }));
  for (const r of expired) bustGrantCache(r.subjectKind, r.subject);
  // One entry per LAPSED RULE, batched. A nightly `{ expired: 4 }` said that four people somewhere lost
  // something - which is exactly the shape of audit entry nobody can act on. Each entry now names the subject,
  // the collection and the pattern, the same `ruleMeta` a grant or a revocation records, so an expiry reads
  // like the revocation it is and the access-change feed can show all three side by side.
  // Every subject of the batch in ONE read, so a nightly tick that lapses twenty rules still costs one.
  const subjects = await subjectWords(deps, expired);
  await auditMany(deps, "system", expired.map((row) => ({
    action: "access-rule.expire",
    entity: "access-rules",
    entityId: row.uuid,
    meta: ruleMeta(row, subjects.get(subjectKey(row))),
    snapshot: row,
  })));
  return expired.length;
}
