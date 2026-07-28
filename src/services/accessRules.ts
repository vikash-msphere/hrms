// The ONE access-rule management service - roles and users, identical mechanism. Each rule is a row in
// access_rules (the sole source of record); the service builds the verbatim pattern ONCE from the structured
// input, then reuses `deriveNarrowing` to fill the narrowing columns and sets match_code for exact rules -
// byte-identical to what the seed's `compileGrant` produces, so a created row is indistinguishable from a
// seeded one and the engine + BOLA oracles never change. No grant blob, no recompile. Super-only via the
// `access-rules` collection key (the middleware gates it).
import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { clearCache, clearCachePrefix } from "../lib/cache";
import { notFound, failedPrecondition, alreadyExists } from "../lib/errors";
import { validateAccessRule, type AccessRuleInput } from "../domain/policyValidate";
import { deriveNarrowing } from "../domain/compileGrants";
import { EVERYONE_ROLE } from "../domain/grants";
import { uuidToCode, codeToUuid } from "../lib/authzResolve";
import { toAccessRuleResource } from "../http/serialize";
import { paginate } from "../http/pagination";

// Build the verbatim pattern for a normalized rule. The id-position token encodes the scope (me / my-dept /
// <code> / <code>-* / * for a field rule); a field rule inserts the field token; the tail is the verb for a
// custom-method rule, else `**` (full subtree at that scope). This is the SINGLE pattern-derivation site.
async function buildPattern(deps: Deps, r: AccessRuleInput): Promise<string> {
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
  } else if (r.field || r.verb) idToken = "*"; // scope=all + field/verb -> any item (`collection.*.<field|verb>`)
  const toks = [r.collection];
  if (idToken) toks.push(idToken);
  if (r.field) toks.push(r.field);
  toks.push(r.verb ? r.verb : "**"); // verb -> the custom-method key; `**` -> standard methods + sub-resources
  return toks.join(".");
}

const ruleById = (id: string) => eq(schema.accessRules.id, id);

// Bust the cached broad grant a rule edit affects. A user rule busts that user's grant; a normal role rule
// busts that role's grant; an `everyone` rule busts the WHOLE `grant:` band, since `everyone` is unioned into
// every role's cached grant (loadRoleGrant). `everyone` edits are rare admin actions, so the band flush is fine.
function bustGrantCache(subjectKind: "role" | "user", subject: string): void {
  if (subjectKind === "user") clearCache(`userGrant:${subject}`);
  else if (subject === EVERYONE_ROLE) clearCachePrefix("grant:");
  else clearCache(`grant:${subject}`);
}

async function serialize(deps: Deps, r: typeof schema.accessRules.$inferSelect) {
  const objectUuid = r.scopeKind === "exact" && r.matchCode ? await codeToUuid(deps, r.namespace, r.matchCode) : null;
  return toAccessRuleResource(r, objectUuid);
}

export async function listAccessRules(deps: Deps, maxPageSize = 50, pageToken?: string) {
  const rows = await deps.db.select().from(schema.accessRules);
  const page = paginate(rows, maxPageSize, pageToken, (r) => +new Date(r.createdAt), (r) => r.id);
  const results = await Promise.all(page.items.map((r) => serialize(deps, r)));
  return { results, nextPageToken: page.nextPageToken };
}

export async function getAccessRule(deps: Deps, id: string) {
  const row = (await deps.db.select().from(schema.accessRules).where(ruleById(id)).limit(1))[0];
  if (!row) throw notFound("access rule not found");
  return serialize(deps, row);
}

export async function createAccessRule(deps: Deps, actor: AppUser, body: unknown) {
  const r = validateAccessRule(body, actor.policy);

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
  } as const;

  // Dedup at row grain (no new DB index - keep the read query plan untouched): the same (subject, pattern,
  // effect) is a duplicate. Editing a level = delete the old rule then create the new one.
  const dup = (
    await deps.db
      .select({ id: schema.accessRules.id })
      .from(schema.accessRules)
      .where(and(eq(schema.accessRules.subject, subject), eq(schema.accessRules.subjectKind, r.subjectKind), eq(schema.accessRules.pattern, pattern), eq(schema.accessRules.effect, r.effect)))
      .limit(1)
  )[0];
  if (dup) throw alreadyExists("an identical access rule already exists");

  const [row] = await deps.db.insert(schema.accessRules).values(values).returning();
  bustGrantCache(r.subjectKind, subject); // bust the cached broad grant
  await audit(deps, actor, "access-rule.create", "access-rules", row!.id);
  return serialize(deps, row!);
}

export async function deleteAccessRule(deps: Deps, actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.accessRules).where(ruleById(id)).limit(1))[0];
  if (!row) throw notFound("access rule not found");
  if (row.subjectKind === "role" && row.subject === actor.role) throw failedPrecondition("cannot edit rules of the role you are using");
  await deps.db.delete(schema.accessRules).where(ruleById(id));
  bustGrantCache(row.subjectKind, row.subject);
  await audit(deps, actor, "access-rule.delete", "access-rules", id);
}
