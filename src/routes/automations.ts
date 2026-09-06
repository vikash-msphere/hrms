import { z } from "zod";
import * as schema from "../db/schema";
import { collectionRoutes } from "../http/collectionRoute";
import { jsonBody } from "../http/jsonRequest";
import {
  listAutomations, createAutomation, updateAutomation, deleteAutomation, setAutomationEnabled, testAutomation,
  type AutomationInput,
} from "../services/automations";
import { toAutomationResource } from "../http/serialize";

// condition/actions/schedule are validated in depth by the pure domain validator (services/automations); the
// schema only enforces the transport shape (JSON objects), keeping the rule grammar in ONE place. `schedule`
// belongs here for the same reason the others do: the builder sends it on every write (null for an
// event-triggered rule), and a `.strict()` object that does not name it rejects the whole body - which is a
// scheduled rule that cannot be authored at all, and an event rule the builder cannot save either.
const writeSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  trigger_type: z.string().min(1).optional(),
  condition: z.any().nullable().optional(),
  actions: z.array(z.any()).optional(),
  enabled: z.boolean().optional(),
  schedule: z.any().nullable().optional(),
}).strict();

// Data-driven automation rules. Every write is the service's own: a rule is validated as a whole (a partial
// patch is merged and re-validated), the actions a caller may author are gated, and each write drops the
// engine's rule cache. Deleting one is a real removal - the table carries no delete_time - so there is no
// `:restore` and no `?force`.
export const automations = collectionRoutes<AutomationInput, typeof schema.automations>({
  table: schema.automations,
  collection: "automations",
  auditName: "automation",
  notFound: "automation not found",
  param: "automation_id",
  writeSchema,
  serialize: toAutomationResource,
  overrides: {
    create: (deps, actor, input, id) => createAutomation(deps, actor, input, id),
    update: (deps, actor, id, patch, ifMatch) => updateAutomation(deps, actor, id, patch, ifMatch),
    // A hard delete: a rule that no longer exists must not sit in the trash still firing.
    remove: (deps, actor, id, ifMatch) => deleteAutomation(deps, actor, id, ifMatch),
  },
  // Rules are admin-only, so this list is the caller's own rather than a code-scoped one.
  list: (c, page) => listAutomations(c.get("deps"), c.get("user"), page.maxPageSize, page.pageToken),
  verbs: {
    // The collection's OWN :enable / :disable, answered before the shared lifecycle lane. They write the same
    // `disabled` column and record the same audit stem; what they add is dropping the engine's rule cache, so a
    // rule switched off stops firing now rather than when the cache expires.
    enable: { run: (deps, user, id) => setAutomationEnabled(deps, user, id, true) },
    disable: { run: (deps, user, id) => setAutomationEnabled(deps, user, id, false) },
    // Dry run: report which actions WOULD fire for a sample event, executing none of them. Answers a report,
    // not the rule, so it owns its response.
    test: {
      raw: async (c, id) => {
        const body = await jsonBody<{ employee_id?: string; payload?: Record<string, unknown> }>(c);
        return c.json(await testAutomation(c.get("deps"), c.get("user"), id, { employeeId: body.employee_id, payload: body.payload }) as object);
      },
    },
  },
});
