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
import type { StructureLine } from "../domain/payroll";

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
  const comps = (await deps.db.select().from(schema.payComponents)).filter((c) => !c.deleteTime);
  const byId = new Map(comps.map((c) => [c.uuid, c]));
  const seen = new Set<string>();
  const out: StructureLine[] = [];
  for (const l of lines) {
    const id = idOf(l.component);
    if (!id) throw invalidArgument("each structure line needs a component");
    const c = byId.get(id);
    if (!c) throw notFound("pay component not found in a structure line");
    if (c.kind !== "earning") throw invalidArgument(`"${c.name}" is a deduction; a structure governs earnings only`);
    // rate_qty is priced per run (rate x quantity), so it has no fixed monthly value and contributes 0 to the
    // CTC split a structure defines - listing it would show a misleading 0 line and never flag the split stale.
    if (c.method === "rate_qty") throw invalidArgument(`"${c.name}" is a rate x quantity component; it has no fixed monthly value, so it cannot sit in a salary structure (add it as a global earning instead)`);
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

export async function listSalaryStructures(deps: Deps, _actor: AppUser, maxPageSize: number, pageToken?: string, showDeleted = false) {
  const all = visibleByDelete(await deps.db.select().from(schema.salaryStructures), showDeleted).sort(
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

export async function getSalaryStructure(deps: Deps, _actor: AppUser, id: string) {
  const row = (await deps.db.select().from(schema.salaryStructures).where(eq(schema.salaryStructures.uuid, id)).limit(1))[0];
  if (!row) throw notFound("salary structure not found");
  return row;
}

export async function createSalaryStructure(deps: Deps, actor: AppUser, input: SalaryStructureInput, id?: string) {
  if (!input.display_name) throw invalidArgument("display_name is required");
  const lines = await normalizeLines(deps, input.lines ?? []);
  const row = (await deps.db
    .insert(schema.salaryStructures)
    .values({
      ...(id ? { id } : {}),
      code: await allocFlatCode(deps, schema.salaryStructures),
      name: input.display_name,
      description: input.description ?? null,
      linesJson: JSON.stringify(lines),
    })
    .returning())[0]!;
  await audit(deps, actor, "salary_structure.create", "salary-structures", row.uuid, undefined, row);
  return row;
}

export async function updateSalaryStructure(deps: Deps, actor: AppUser, id: string, patch: SalaryStructureInput, ifMatch?: string) {
  const row = (await deps.db.select().from(schema.salaryStructures).where(eq(schema.salaryStructures.uuid, id)).limit(1))[0];
  if (!row) throw notFound("salary structure not found");
  if (ifMatch && ifMatch !== etagOf(+new Date(row.updatedAt))) throw aborted("etag mismatch");
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const has = (k: keyof SalaryStructureInput) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("display_name")) set.name = patch.display_name;
  if (has("description")) set.description = patch.description ?? null;
  if (has("lines")) set.linesJson = JSON.stringify(await normalizeLines(deps, patch.lines ?? []));
  const updated = (await deps.db.update(schema.salaryStructures).set(set).where(eq(schema.salaryStructures.uuid, id)).returning())[0]!;
  await audit(deps, actor, "salary_structure.update", "salary-structures", id, diffMeta(row, updated, set), updated);
  return updated;
}

export async function deleteSalaryStructure(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await softDeleteRow(deps, actor, schema.salaryStructures, "salary_structure", "salary-structures", id, ifMatch);
}

export async function restoreSalaryStructure(deps: Deps, actor: AppUser, id: string) {
  return restoreRow(deps, actor, schema.salaryStructures, "salary_structure", "salary-structures", id);
}

export async function purgeSalaryStructure(deps: Deps, actor: AppUser, id: string, ifMatch?: string) {
  await purgeRow(deps, actor, schema.salaryStructures, "salary_structure", "salary-structures", id, ifMatch);
}
