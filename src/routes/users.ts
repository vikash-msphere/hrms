import { Hono } from "hono";
import { z } from "zod";
import * as schema from "../db/schema";
import type { AppEnv } from "../env";
import { capabilitiesOf } from "../domain/permissions";
import { collectionRoutes } from "../http/collectionRoute";
import { getUser, listUsers, updateUser, type UserInput } from "../services/users";
import { toUserResource } from "../http/serialize";
import { getSettingValue } from "../services/settings";

const updateSchema = z
  .object({
    // Roles are DATA (the roles table), so this is any string: `updateUser` validates it against the table and
    // refuses the reserved `everyone` subject. A hardcoded enum here would have made a role added through the
    // roles catalog unassignable, which is the opposite of what that catalog is for.
    role: z.string().min(1).optional(),
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
    const withCallerAccess = async <T extends object>(res: T) =>
      c.json({
        ...res,
        holiday_feed_token: await feedToken(),
        caller_access: { capabilities: capabilitiesOf(u.grant), scopes: u.policy.supported_scopes ?? {} },
      });
    // A "view as" subject can be someone who has never signed in: lib/viewAs.ts grades them as the account they
    // WOULD get on first login, so there is no users row to read. Synthesize the identity from the simulated
    // principal instead of 404ing the whole shell - it is the same information a real row would carry, and the
    // simulation is read-only, so nothing keyed on the (absent) account id can be written.
    if (u.simulatedBy && !u.uuid) {
      const now = c.get("deps").clock.now();
      return withCallerAccess(toUserResource({ uuid: "", createdAt: now, updatedAt: now, email: u.email, role: u.role, status: u.status, employeeId: u.employeeId }));
    }
    return withCallerAccess(toUserResource(await getUser(c.get("deps"), u, "me")));
  })
  .route("/", accounts);
