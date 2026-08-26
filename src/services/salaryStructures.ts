import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import type { Deps } from "../deps";
import { invalidArgument, notFound } from "../lib/errors";
import { crudService, has, type CrudSpec, type SetOf } from "./crud";
import type { StructureLine } from "../domain/payroll";
import { refPayComponents } from "../lib/refData";

// A structure line on the wire: `component` is a `pay-components/<id>` ref (the inbound edge decodes the
// token to an internal id; we store just the id). `rate` overrides the component's own rate, or null.
export type StructureLineInput = { component?: string; rate?: number | null };
export type SalaryStructureInput = {
  display_name?: string;
  description?: string | null;
  lines?: StructureLineInput[];
};

const idOf = (ref?: string | null) => (ref ? ref.split("/").pop()! : undefined);
export function parseLines(linesJson: string): StructureLine[] {
  try {
    const arr = JSON.parse(linesJson);
    return Array.isArray(arr) ? arr.filter((l) => l && typeof l.component === "string") : [];
  } catch {
    return [];
  }
}

// Validate + normalise the wire lines into stored lines (internal component ids). Every referenced component
// must exist, be live, and be an EARNING (deductions/statutory aren't part of a structure). No duplicates.
async function normalizeLines(deps: Deps, lines: StructureLineInput[]): Promise<StructureLine[]> {
  const comps = (await refPayComponents(deps)).filter((c) => !c.deleteTime);
  const byId = new Map(comps.map((c) => [c.uuid, c]));
  const seen = new Set<string>();
  const out: StructureLine[] = [];
  for (const l of lines) {
    const id = idOf(l.component);
    if (!id) throw invalidArgument("each structure line needs a component");
    const c = byId.get(id);
    if (!c) throw notFound("pay component not found in a structure line");
    if (c.kind !== "earning") throw invalidArgument(`"${c.name}" is a deduction; a structure governs earnings only`);
    if (seen.has(id)) throw invalidArgument(`"${c.name}" is listed twice`);
    seen.add(id);
    out.push({ component: id, rate: l.rate ?? null });
  }
  return out;
}

// All structures' lines keyed by uuid (live only) - loaded once for a payroll build to avoid N+1 reads.
export async function allStructureLines(deps: Deps): Promise<Map<string, StructureLine[]>> {
  const rows = (await deps.db.select().from(schema.salaryStructures)).filter((s) => !s.deleteTime);
  return new Map(rows.map((s) => [s.uuid, parseLines(s.linesJson)]));
}

// One structure's lines (live), or null when unassigned/missing - the per-employee lookup for letters/encash.
export async function structureLinesById(deps: Deps, structureId?: string | null): Promise<StructureLine[] | null> {
  if (!structureId) return null;
  const s = (await deps.db.select().from(schema.salaryStructures).where(eq(schema.salaryStructures.uuid, structureId)).limit(1))[0];
  if (!s || s.deleteTime) return null;
  return parseLines(s.linesJson);
}

export const salaryStructureSpec: CrudSpec<SalaryStructureInput, typeof schema.salaryStructures> = {
  table: schema.salaryStructures,
  collection: "salary-structures",
  auditName: "salary_structure",
  notFound: "salary structure not found",
  insert: async (input, deps) => {
    if (!input.display_name) throw invalidArgument("display_name is required");
    return {
      name: input.display_name,
      description: input.description ?? null,
      linesJson: JSON.stringify(await normalizeLines(deps, input.lines ?? [])),
    };
  },
  patch: async (patch, _row, deps) => {
    const set: SetOf<typeof schema.salaryStructures> = {};
    if (has(patch, "display_name")) set.name = patch.display_name;
    if (has(patch, "description")) set.description = patch.description ?? null;
    if (has(patch, "lines")) set.linesJson = JSON.stringify(await normalizeLines(deps, patch.lines ?? []));
    return set;
  },
};

export const {
  create: createSalaryStructure,
} = crudService(salaryStructureSpec);
