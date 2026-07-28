// Global body-AC manifest management (super-only via the `policy` collection key). The manifest drives
// field/reference/owner/state/audit body checks. A write strictly validates the shape (validateManifest) so
// a malformed edit is rejected - never silently reverted - then busts the manifest cache.
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit } from "../lib/audit";
import { notFound } from "../lib/errors";
import { validateManifest } from "../domain/policyValidate";
import { clearCache } from "../lib/cache";
import { paginate } from "../http/pagination";

export async function listPolicies(deps: Deps, maxPageSize = 50, pageToken?: string) {
  const rows = await deps.db.select().from(schema.policy);
  return paginate(rows, maxPageSize, pageToken, (r) => +new Date(r.updatedAt), (r) => r.key);
}

export async function getPolicy(deps: Deps, key: string) {
  const row = (await deps.db.select().from(schema.policy).where(eq(schema.policy.key, key)).limit(1))[0];
  if (!row) throw notFound("policy not found");
  return row;
}

export async function updatePolicy(deps: Deps, actor: AppUser, key: string, value: unknown) {
  if (key === "manifest") validateManifest(value); // strict; rejects malformed (the read path never fails open)
  const json = JSON.stringify(value ?? {});
  const existing = (await deps.db.select({ k: schema.policy.key }).from(schema.policy).where(eq(schema.policy.key, key)).limit(1))[0];
  const [row] = existing
    ? await deps.db.update(schema.policy).set({ valueJson: json, updatedAt: new Date() }).where(eq(schema.policy.key, key)).returning()
    : await deps.db.insert(schema.policy).values({ key, valueJson: json }).returning();
  if (key === "manifest") clearCache("manifest");
  await audit(deps, actor, "policy.update", "policy", key);
  return row!;
}
