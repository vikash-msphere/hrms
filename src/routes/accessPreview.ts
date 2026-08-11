import { Hono } from "hono";
import type { AppEnv } from "../env";
import { previewAccess, type PreviewBody } from "../services/accessPreview";
import { requestAccess } from "../services/accessRequest";
import { decideAccessRule, ruleIdFromRef } from "../services/accessRules";

// Collection-level custom methods on access-rules (each mounted whole in index.ts, like batch:run).
// Authz rides the normal middleware lane: the resolver sees the custom keys (`access-rules.preview`,
// `access-rules.requestAccess`), which are fail-closed - super by default; preview is granted to access
// admins, requestAccess to `everyone` when an org wants the request flow.
export const accessPreviewRoute = new Hono<AppEnv>().post("/", async (c) => {
  const body = (await c.req.json()) as PreviewBody;
  return c.json({ results: await previewAccess(c.get("deps"), body) });
});

export const accessRequestRoute = new Hono<AppEnv>().post("/", async (c) =>
  c.json(await requestAccess(c.get("deps"), c.get("user"), await c.req.json())),
);

// Four-eyes decisions on a pending permission change. Collection-level (the rule travels in the body) so
// they key as `access-rules.approve` / `access-rules.reject` - fail-closed like every custom method, so
// approval authority is grantable independently of the write that queues the change.
const decideRoute = (decision: "approve" | "reject") =>
  new Hono<AppEnv>().post("/", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { rule?: unknown };
    return c.json(await decideAccessRule(c.get("deps"), c.get("user"), ruleIdFromRef(body.rule), decision));
  });

export const accessApproveRoute = decideRoute("approve");
export const accessRejectRoute = decideRoute("reject");
