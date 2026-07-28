import { eq } from "drizzle-orm";
import { allocFlatCode } from "./codeAlloc";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import type { AppUser } from "../env";
import { audit, diffMeta } from "../lib/audit";
import { invalidArgument, notFound, aborted } from "../lib/errors";
import { encodeCursor, decodeCursor } from "../http/pagination";
import { etagOf } from "../http/serialize";
import { visibleByDelete, softDeleteRow, restoreRow, purgeRow } from "./softDelete";
import type { LetterTemplate, TemplateBlock, TemplateInput } from "../domain/letters";

// Letter templates as a first-class collection: each row is an addressable object, so per-template access is
// the real authz engine (READ = who may generate this letter type, WRITE = who may edit it). Flat config,
// hr_admin-managed (seed grants). The editable content (blocks/inputs) is stored as JSON. See schema.ts.
export type LetterTemplateInput = {
  label?: string;
  category?: string | null;
  filename?: string | null;
  inputs?: TemplateInput[] | null;
  blocks?: TemplateBlock[];
};

const idFromPath = (p?: string | null) => (p ? p.split("/").pop()! : undefined);

// Map a stored row to the domain LetterTemplate the resolver consumes (id = the row uuid).
export function rowToLetterTemplate(row: typeof schema.letterTemplates.$inferSelect): LetterTemplate {
  return {
    id: row.uuid,
    label: row.label,
    category: row.category ?? undefined,
    filename: row.filename ?? undefined,
    inputs: (row.inputs as TemplateInput[] | null) ?? undefined,
    blocks: (row.blocks as TemplateBlock[] | null) ?? [],
  };
}

export async function listLetterTemplates(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.letterTemplates), showDeleted).sort(
    (a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.uuid.localeCompare(b.uuid),
  );
  const cur = decodeCursor(pageToken);
  const start = cur
    ? all.findIndex((e) => +new Date(e.createdAt) > cur.createTimeMs || (+new Date(e.createdAt) === cur.createTimeMs && e.uuid > cur.uid))
    : 0;
  const slice = start < 0 ? [] : all.slice(start, start + maxPageSize);
  const last = slice[slice.length - 1];
  const nextPageToken = start >= 0 && start + maxPageSize < all.length && last ? encodeCursor(+new Date(last.createdAt), last.uuid) : undefined;
  return { items: slice, nextPageToken };
}

export async function getLetterTemplate(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.letterTemplates).where(eq(schema.letterTemplates.uuid, id)).limit(1))[0];
  if (!row || row.deleteTime) throw notFound("letter template not found");
  return row;
}

// Resolve a letter template by id (the decoded `letter-templates/{uuid}` ref or a bare uuid). Returns the
// domain shape for the resolver, or undefined when absent/deleted.
export async function findLetterTemplate(deps: Deps, ref: string): Promise<LetterTemplate | undefined> {
  const id = idFromPath(ref);
  if (!id) return undefined;
  const row = (await deps.db.select().from(schema.letterTemplates).where(eq(schema.letterTemplates.uuid, id)).limit(1))[0];
  return row && !row.deleteTime ? rowToLetterTemplate(row) : undefined;
}

export async function createLetterTemplate(deps: Deps, actor: AppUser, input: LetterTemplateInput, id?: string) {
  if (!input.label) throw invalidArgument("label is required");
  const row = (await deps.db
    .insert(schema.letterTemplates)
    .values({ code: await allocFlatCode(deps, schema.letterTemplates), ...(id ? { id } : {}), label: input.label, category: input.category ?? null, filename: input.filename ?? null, inputs: input.inputs ?? null, blocks: input.blocks ?? [] })
    .returning())[0]!;
  await audit(deps, actor, "letter-template.create", "letter-templates", row.uuid, undefined, row);
  return row;
}

export async function updateLetterTemplate(deps: Deps, actor: AppUser, id: string, patch: LetterTemplateInput, ifMatch?: string) {
  const row = await getLetterTemplate(deps, actor, id);
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const has = (k: keyof LetterTemplateInput) => Object.prototype.hasOwnProperty.call(patch, k);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (has("label")) { if (!patch.label) throw invalidArgument("label cannot be empty"); set.label = patch.label; }
  if (has("category")) set.category = patch.category ?? null;
  if (has("filename")) set.filename = patch.filename ?? null;
  if (has("inputs")) set.inputs = patch.inputs ?? null;
  if (has("blocks")) set.blocks = patch.blocks ?? [];
  const updated = (await deps.db.update(schema.letterTemplates).set(set).where(eq(schema.letterTemplates.uuid, id)).returning())[0]!;
  await audit(deps, actor, "letter-template.update", "letter-templates", id, diffMeta(row, updated, set), updated);
  return updated;
}

export const deleteLetterTemplate = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) =>
  softDeleteRow(deps, actor, schema.letterTemplates, "letter template", "letter-templates", id, ifMatch);
export const restoreLetterTemplate = (deps: Deps, actor: AppUser, id: string) =>
  restoreRow(deps, actor, schema.letterTemplates, "letter template", "letter-templates", id);
export const purgeLetterTemplate = (deps: Deps, actor: AppUser, id: string, ifMatch?: string) =>
  purgeRow(deps, actor, schema.letterTemplates, "letter template", "letter-templates", id, ifMatch);
