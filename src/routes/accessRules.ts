import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { createAccessRule, deleteAccessRule, listAccessRules, withObjectRefs } from "../services/accessRules";
import { toAccessRuleResource } from "../http/serialize";

// The single access-control management surface: one rule (role OR user) per row. Super-only by default via the
// `access-rules` collection key (the middleware gates it). There is no PATCH - editing a rule means deleting it
// and creating the replacement, so the change is two auditable events rather than a silent rewrite of a grant.
// The four collection-level methods (:preview, :requestAccess, :approve, :reject) are separate routes mounted
// ahead of this one, because each is gated by its own verb rather than by the collection's write level.
export const accessRules = collectionRoutes<unknown, typeof schema.accessRules>({
  table: schema.accessRules,
  collection: "access-rules",
  auditName: "access-rule",
  notFound: "access rule not found",
  param: "access_rule_id",
  // Taken as sent: the rule grammar is validated in ONE place, by validateAccessRule against the live policy
  // manifest, which knows which collections, scopes, levels and verbs exist. A zod shape here would be a second,
  // weaker copy of that.
  createSchema: z.unknown(),
  // `?collection=` and `?subject_kind=&subject=` narrow the list to what one editor is about (services/
  // accessRules.ts listAccessRules says why); with neither it is every rule, as before.
  list: (c, page) =>
    listAccessRules(c.get("deps"), c.get("scope"), page.maxPageSize, page.pageToken, {
      collection: c.req.query("collection"),
      subjectKind: c.req.query("subject_kind"),
      subject: c.req.query("subject"),
    }),
  serialize: (row) => toAccessRuleResource(row, row._objectUuid ?? null),
  decorate: (deps, _actor, rows) => withObjectRefs(deps, rows),
  overrides: {
    // Validates the rule, guards the subject, busts the cached grant, and under four-eyes writes it `pending`
    // (inert) instead of active.
    create: (deps, actor, input) => createAccessRule(deps, actor, input),
    // A real removal, with no `:restore` and no `?force`: a grant left in the trash would be a grant nobody can
    // see. Under four-eyes it marks the row `pending_delete` (which keeps enforcing) rather than deleting.
    remove: (deps, actor, id) => deleteAccessRule(deps, actor, id),
  },
});
