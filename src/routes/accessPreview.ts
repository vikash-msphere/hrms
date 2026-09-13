import { Hono } from "hono";
import type { AppEnv } from "../env";
import { jsonBody } from "../http/jsonRequest";
import { previewAccess, type PreviewBody } from "../services/accessPreview";
import { requestAccess } from "../services/accessRequest";
import { cloneAccessRules, decideAccessRule, ruleIdFromRef } from "../services/accessRules";

// Collection-level custom methods on access-rules (each mounted whole in index.ts, like batch:run).
// Authz rides the normal middleware lane: the resolver sees the custom keys (`access-rules.preview`,
// `access-rules.requestAccess`), which are fail-closed - super by default; preview is granted to access
// admins, requestAccess to `everyone` when an org wants the request flow.
export const accessPreviewRoute = new Hono<AppEnv>().post("/", async (c) => {
  const body = await jsonBody<PreviewBody>(c);
  // The caller rides along: the verb key is collection-level and carries no object, so the only place the
  // SUBJECTS can be scoped to what this caller may see is inside (services/accessPreview.ts).
  return c.json({ results: await previewAccess(c.get("deps"), body, c.get("user")) });
});

export const accessRequestRoute = new Hono<AppEnv>().post("/", async (c) =>
  c.json(await requestAccess(c.get("deps"), c.get("user"), await jsonBody(c))),
);

// Four-eyes decisions on a pending permission change. Collection-level (the rule travels in the body) so
// they key as `access-rules.approve` / `access-rules.reject` - fail-closed like every custom method, so
// approval authority is grantable independently of the write that queues the change.
const decideRoute = (decision: "approve" | "reject") =>
  new Hono<AppEnv>().post("/", async (c) => {
    const body = await jsonBody<{ rule?: unknown }>(c);
    return c.json(await decideAccessRule(c.get("deps"), c.get("user"), ruleIdFromRef(body.rule), decision));
  });

export const accessApproveRoute = decideRoute("approve");
export const accessRejectRoute = decideRoute("reject");

// Copy every rule one subject holds onto another, in ONE request, under ONE correlation id. Collection-level
// (both subjects travel in the body), so it keys as `access-rules.clone` - fail-closed like every custom
// method, which is what makes bulk copying grantable separately from authoring rules one at a time.
export const accessCloneRoute = new Hono<AppEnv>().post("/", async (c) =>
  c.json(await cloneAccessRules(c.get("deps"), c.get("user"), await jsonBody(c))),
);
