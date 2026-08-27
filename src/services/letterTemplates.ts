import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument } from "../lib/errors";
import { has, type CrudSpec, type SetOf } from "./crud";
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

// Resolve a letter template by id (the decoded `letter-templates/{uuid}` ref or a bare uuid). Returns the
// domain shape for the resolver, or undefined when absent/deleted.
export async function findLetterTemplate(deps: Deps, ref: string): Promise<LetterTemplate | undefined> {
  const id = idFromPath(ref);
  if (!id) return undefined;
  const row = (await deps.db.select().from(schema.letterTemplates).where(eq(schema.letterTemplates.uuid, id)).limit(1))[0];
  return row && !row.deleteTime ? rowToLetterTemplate(row) : undefined;
}

export const letterTemplateSpec: CrudSpec<LetterTemplateInput, typeof schema.letterTemplates> = {
  table: schema.letterTemplates,
  collection: "letter-templates",
  auditName: "letter-template",
  notFound: "letter template not found",
  insert: (input) => {
    if (!input.label) throw invalidArgument("label is required");
    return {
      label: input.label,
      category: input.category?.trim() || null,
      filename: input.filename?.trim() || null,
      inputs: input.inputs ?? null,
      blocks: input.blocks ?? [],
    };
  },
  patch: (patch) => {
    const set: SetOf<typeof schema.letterTemplates> = {};
    if (has(patch, "label")) { if (!patch.label) throw invalidArgument("label cannot be empty"); set.label = patch.label; }
    if (has(patch, "category")) set.category = patch.category?.trim() || null;
    if (has(patch, "filename")) set.filename = patch.filename?.trim() || null;
    if (has(patch, "inputs")) set.inputs = patch.inputs ?? null;
    if (has(patch, "blocks")) set.blocks = patch.blocks ?? [];
    return set;
  },
};

