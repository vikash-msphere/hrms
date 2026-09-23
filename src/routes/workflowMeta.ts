import { Hono } from "hono";
import type { AppEnv } from "../env";
import { buildWorkflowMeta } from "../domain/workflowMeta";
import { ACCESS_VERBS } from "../http/accessHint";

// Builder metadata for the no-code Workflow builder: event catalog + resource/verb catalog + enum vocabularies.
// Virtual capability collection (no table): the authz middleware gates GET as `workflow-meta.read` (HR/super).
// Pure assembly from EVENT_TYPES + ACCESS_VERBS + the automations domain enums, so the UI never drifts.
//
// A singleton resource, so it carries its own `path` like every other singleton (bank-account, bio).
export const workflowMeta = new Hono<AppEnv>().get("/", (c) => c.json({ path: "workflow-meta", ...buildWorkflowMeta(ACCESS_VERBS) }));
