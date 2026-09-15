import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { capabilitiesOf } from "../domain/permissions";
import { grantableScopes } from "../domain/manifests";
import { conditionableFields } from "../domain/ruleCondition";
import { collectionRoutes } from "../http/collectionRoute";
import { getUser, listUsers, updateUser, type UserInput, decorateUserRoles } from "../services/users";
import { toUserResource } from "../http/serialize";
import { getSettingValue } from "../services/settings";

const updateSchema = z
  .object({
    // Roles are DATA (the roles table), so this is any string: `updateUser` validates it against the table and
    // refuses the reserved `everyone` subject. A hardcoded enum here would have made a role added through the
    // roles catalog unassignable, which is the opposite of what that catalog is for.
    role: z.string().min(1).optional(),
    // The SECONDARY roles, replaced wholesale. Same reasoning as `role` above for why these are plain strings:
    // roles are data, and `updateUser` validates them against the table. An empty array clears the set.
    roles: z.array(z.string().min(1)).max(20).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    employee: z.string().nullable().optional(),
  })
  .strict();

// Sign-in accounts. There is no create and no delete: an account is provisioned when an employee is created
// and disabled rather than removed, so the lane mounts list, get and patch only.
const accounts = collectionRoutes<UserInput, typeof schema.users>({
  table: schema.users,
  collection: "users",
  auditName: "user",
  notFound: "user not found",
  param: "user_id",
  updateSchema,
  serialize: toUserResource,
  overrides: {
    // The role is validated against the roles table, and an admin can neither strip their own role nor disable
    // their own account (the lockout guard).
    update: (deps, actor, id, patch, ifMatch) => updateUser(deps, actor, id, patch, ifMatch),
  },
  // Scoped by the account's employee link, which the generic list cannot bind (it knows a table's `code`, not
  // which column owns the row). Without it everyone who may read their own account could list every account.
  list: (c, page) => listUsers(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken),
  // The SECONDARY roles each account holds, in ONE read for the whole page - the same shape every other derived
  // field on this factory uses, so item, list and the write response all carry it without three spellings.
  // `users.role` is on the row already; this is only the join table.
  decorate: (deps, _actor, rows) => decorateUserRoles(deps, rows),
});

// `users/me` is NOT a collection item: it answers about the CALLER. It carries the capability set the SPA gates
// its UI on plus the per-collection grantable scope tiers, and it has to answer for a simulated principal who
// has no row at all. Registered ahead of the lane so it wins over the item path.
export const users = new Hono<AppEnv>()
  .get("/me", async (c) => {
    const u = c.get("user");
    // The caller's holiday-feed token (see routes/holidayFeed.ts) rides on identity rather than a custom method
    // of its own: it is a fact about the caller, and this response is already fetched once per session. Withheld
    // from a simulated principal - a durable subscribe URL is a credential, and "view as" is read-only.
    const feedToken = async () => {
      if (!u.employeeId || u.simulatedBy) return undefined;
      const deps = c.get("deps");
      const cfg = await getSettingValue<{ feed_enabled?: boolean }>(deps, "holidays", {});
      if (!cfg.feed_enabled) return undefined;
      return deps.idCodec.encode("holiday-feed", u.employeeId);
    };
    // The caller's SITTING, so the SPA can scope its on-disk caches to it.
    //
    // The record store and the photo/settings caches are namespaced by EMAIL (web/src/App.tsx `cacheUser`),
    // which is what keeps two people sharing a browser apart - and which also means a cache written under one
    // session is adopted by the next. Closing the tab is the ordinary way a person leaves, and it clears
    // nothing: only an explicit sign-out purges (web/src/lib/clientStore.ts `purgeAll`). So employee records
    // and salary figures sat unencrypted on a shared machine until somebody signed in again.
    //
    // Folding this in makes the cache live exactly as long as the session that filled it: a reload or a return
    // to the same session still hydrates from disk (which is the whole point of the cache), and a new sign-in
    // is a new namespace whose predecessor's records are deleted rather than read. It is deliberately OPAQUE -
    // the underlying value is `<user id>:<issue instant>`, and only its equality matters to the client.
    //
    // Absent on the lanes that carry no session (API key, Access JWT, dev bypass): a principal with no session
    // has nothing for a cache to outlive, and inventing a value would make the namespace change on every
    // request. `simulatedBy` carries the real admin's sitting, so a simulation is scoped to it too.
    const sessionId = u.simulatedBy?.sessionId ?? u.sessionId;
    const withCallerAccess = async <T extends object>(res: T) =>
      c.json({
        ...res,
        holiday_feed_token: await feedToken(),
        ...(sessionId ? { session_id: sessionId } : {}),
        // `grantableScopes`, not the raw manifest map: a tier the UI must offer can be DERIVED from another
        // (named-dept from dept), and the chips have to reflect what the engine honours, not what the row stores.
        caller_access: { capabilities: capabilitiesOf(u.grant), scopes: grantableScopes(u.policy), condition_fields: conditionableFields() },
      });
    // A "view as" subject can be someone who has never signed in: lib/viewAs.ts grades them as the account they
    // WOULD get on first login, so there is no users row to read. Synthesize the identity from the simulated
    // principal instead of 404ing the whole shell - it is the same information a real row would carry, and the
    // simulation is read-only, so nothing keyed on the (absent) account id can be written.
    if (u.simulatedBy && !u.uuid) {
      const now = c.get("deps").clock.now();
      return withCallerAccess(toUserResource({ uuid: "", createdAt: now, updatedAt: now, email: u.email, role: u.role, roles: u.roles.filter((r) => r !== u.role), status: u.status, employeeId: u.employeeId }));
    }
    return withCallerAccess(toUserResource((await decorateUserRoles(c.get("deps"), [await getUser(c.get("deps"), u, "me")]))[0]));
  })
  .route("/", accounts);
