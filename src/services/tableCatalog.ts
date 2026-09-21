// Derives the table builder's field catalogue from the SCHEMA rather than from a hand-written list: a base's
// own columns come from its drizzle table, and the links to other collections come from that table's foreign
// keys. A column added to the schema therefore shows up in the builder, and a link can never point at a
// collection nobody reviewed - a link is offered only when its target is itself a registered base
// (domain/tableFields.BASES).
//
// Nothing here decides access. `listable` is the set of collections the middleware already decided this
// caller may list; every field this file emits names the collection that gated it, and a field whose
// collection is not in that set is never emitted at all.
import { getTableColumns } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { TABLES, listOwnerColumn } from "../lib/authzResolve";
import { scopeCanMatch } from "./listScope";
import type { ListScope } from "../domain/access";
import {
  BASES, SOURCES, SOURCE_PREFIX, columnAllowed, humanize, isMoneyColumn,
  type FieldKind, type SourceDef,
} from "../domain/tableFields";
import { METRICS, METRIC_GROUPS } from "../domain/peopleAnalytics";
import type { Deps } from "../deps";
import { getFieldDefs } from "./identityDetails";
import { refLeaveTypes, refPayComponents } from "../lib/refData";

/**
 * One offerable column, resolved down to how it is FETCHED - the same record the runner plans from, so the
 * builder and the run can never disagree about what a key means.
 */
export type ResolvedField = {
  /** The catalogue key, as stored in a saved view. */
  key: string;
  label: string;
  /**
   * The link names walked to reach this field's node ("Manager", "Department"), absent at the base. A grid
   * draws several nodes' columns side by side, where "Name" on its own says nothing about whose name it is;
   * this is what a header is qualified WITH, as far as it has to be - see domain/tableHeaders.
   */
  trail?: readonly string[];
  /** This field is its node's own name, so the trail alone can stand as a header ("Department"). */
  nodeName?: boolean;
  /** Which group the picker files it under. */
  group: string;
  kind: FieldKind;
  /** The collection whose LIST decision gates it. */
  collection: string;
  /** Further collections the value leans on. */
  needs?: readonly string[];
  /** FK columns (drizzle property names) to walk from the base row to the row this field lives on. */
  path: string[];
  /** Set when the value comes from a source rather than from a column. */
  source?: string;
  /** The column's drizzle property name, or the source's own field id. */
  leaf: string;
  /** Enum values, for a select filter. */
  enumValues?: readonly string[];
  /** For a `ref` field, the collection its id belongs to - emitted as `<collection>/<id>` and tokenized. */
  refCollection?: string;
  /** PII the profile endpoint masks; raw values need the `unmask` capability. */
  masked?: boolean;
  /** Employee sub-resource this field is field-access-gated under. */
  subresource?: string;
  /** The field key inside that sub-resource, for the per-field decision (`identity.pan`). */
  fieldKey?: string;
};

export type Catalogue = {
  base: string;
  label: string;
  /** The dotted wire path this node sits at (empty at the base). */
  path: string;
  /** What this node is called in the trail ("Requester (People)"). Absent at the base. */
  nodeLabel?: string;
  /** The collection this node's own fields belong to. */
  collection?: string;
  groups: { key: string; label: string }[];
  fields: ResolvedField[];
  /** Where you can go from here. Empty at the depth cap. */
  links: CatalogueLink[];
};

// collection name for a drizzle table, so a foreign key can be turned back into a wire collection.
const COLLECTION_BY_TABLE = new Map<string, string>(
  Object.entries(TABLES).map(([collection, table]) => [getTableConfig(table as SQLiteTable).name, collection]),
);

const kindOf = (collection: string, column: string, dataType: string, enumValues?: readonly string[]): FieldKind => {
  if (enumValues?.length) return "enum";
  switch (dataType) {
    case "boolean": return "bool";
    case "date": return column === "createdAt" || column === "updatedAt" ? "datetime" : "date";
    case "number": return isMoneyColumn(collection, column) ? "money" : "number";
    default: return "text";
  }
};

// An id-shaped column is never a column of the grid. A declared foreign key is offered as its LINK instead -
// `employee_id.first_name` says something, `employee_id` is a token - and an id-shaped column that is NOT a
// foreign key holds a bare internal id with no constraint behind it, which must not be published at all.
//
// The suffixes are the ones the schema actually uses for those: `decided_by` / `paid_by` / `verified_by` (a
// bare user id), `manager_ids` / `interviewer_ids` / `attendee_ids` (a LIST of employee ids in ONE column,
// which the runner's single-id guard would not catch), and `scope_ref` (a department or employee id).
// `payment_ref` falls to the same rule and is an ordinary bank reference - a column lost to a rule that fails
// closed, which is the right side to lose it on. Pinned by test/tableFields.test.ts.
const ID_SHAPED = /(Id|Ids|By|Ref)$/;

/** Is this column offered as a field of `collection`? Exported so the drift gate can assert on the real rule. */
export const columnOffered = (collection: string, jsKey: string): boolean =>
  columnAllowed(collection, jsKey) && !ID_SHAPED.test(jsKey);

/** The columns of one base, as fields rooted at `path`. */
function columnFields(collection: string, path: string[], group: string, prefix: string): ResolvedField[] {
  const table = TABLES[collection];
  if (!table) return [];
  const out: ResolvedField[] = [];
  for (const [jsKey, col] of Object.entries(getTableColumns(table as SQLiteTable))) {
    if (!columnAllowed(collection, jsKey) || ID_SHAPED.test(jsKey)) continue;
    const c = col as { name: string; dataType: string; enumValues?: string[] };
    out.push({
      key: prefix + c.name,
      label: humanize(jsKey),
      // The column a record is KNOWN by. Only these two, because a header that collapses to the link name
      // ("Department", holding "Engineering") has to be the thing the reader would have written by hand -
      // which `code`, `subject` or any other candidate is not.
      nodeName: jsKey === "name" || jsKey === "title" || undefined,
      group,
      kind: kindOf(collection, jsKey, c.dataType, c.enumValues),
      collection,
      path,
      leaf: jsKey,
      enumValues: c.enumValues?.length ? c.enumValues : undefined,
    });
  }
  return out;
}

/** The foreign keys of `collection` that point at another REGISTERED base, as [fk column js key, target]. */
function linksOf(collection: string): { column: string; wire: string; target: string }[] {
  const table = TABLES[collection];
  if (!table) return [];
  const cols = getTableColumns(table as SQLiteTable);
  const byName = new Map(Object.entries(cols).map(([jsKey, c]) => [(c as { name: string }).name, jsKey]));
  const out: { column: string; wire: string; target: string }[] = [];
  for (const fk of getTableConfig(table as SQLiteTable).foreignKeys) {
    const ref = fk.reference();
    if (ref.columns.length !== 1) continue; // composite keys are not a to-one link a grid can follow
    const wire = ref.columns[0]!.name;
    const jsKey = byName.get(wire);
    const target = COLLECTION_BY_TABLE.get(getTableConfig(ref.foreignTable as SQLiteTable).name);
    if (!jsKey || !target || !BASES[target] || !columnAllowed(collection, jsKey)) continue;
    out.push({ column: jsKey, wire, target });
  }
  return out;
}

// ---- Per-employee sources -------------------------------------------------------------------------------

/** The fields a source offers. `dynamic` sources read config, which is why this is async and takes deps. */
async function sourceFields(deps: Deps, src: SourceDef, path: string[], prefix: string, group: string): Promise<ResolvedField[]> {
  const f = (leaf: string, label: string, kind: FieldKind, extra: Partial<ResolvedField> = {}): ResolvedField => ({
    key: `${prefix}${SOURCE_PREFIX}${src.key}.${leaf}`,
    label,
    group,
    kind,
    collection: src.collection,
    needs: src.needs,
    path,
    source: src.key,
    leaf,
    masked: src.maskable || undefined,
    subresource: src.subresource,
    ...extra,
  });
  switch (src.key) {
    case "identity": {
      // Admin-configured (settings/employee_fields), so the catalogue follows the org's own field list.
      const defs = await getFieldDefs(deps);
      return defs.map((d) => f(d.key, d.label, "text", { masked: d.sensitive || undefined, fieldKey: d.key }));
    }
    case "personal":
      return [
        ["personal_email", "Personal email"], ["personal_phone", "Personal phone"], ["alternate_phone", "Alternate phone"],
        ["date_of_birth", "Date of birth"], ["gender", "Gender"], ["marital_status", "Marital status"],
        ["communication_address", "Communication address"], ["permanent_address", "Permanent address"],
        ["emergency_name", "Emergency contact"], ["emergency_phone", "Emergency phone"], ["emergency_relation", "Emergency relation"],
        ["blood_group", "Blood group"],
      ].map(([k, l]) => f(k!, l!, k === "date_of_birth" ? "date" : "text", { fieldKey: k }));
    case "bank":
      // The keys the bank blob actually stores (services/bankDetails StoredBank). `branch` is a valid
      // field-access target but not a stored field, so offering it would be a column that is always empty.
      return [
        ["bank_name", "Bank"], ["account_name", "Account name"], ["account_number", "Account number"],
        ["ifsc_code", "IFSC code"], ["currency_code", "Account currency"],
      ].map(([k, l]) => f(k!, l!, "text", { fieldKey: k, masked: k === "account_number" || undefined }));
    case "comp": {
      const base: ResolvedField[] = [
        f("ctc_annual", "Annual CTC", "money"),
        f("base_pay", "Base pay (monthly)", "money"),
        f("special_allowance", "Special allowance", "money"),
        f("effective_from", "Compensation effective from", "date"),
        f("pay_grade", "Pay grade", "text"),
        f("structure", "Salary structure", "text"),
        f("ctc_monthly", "Monthly CTC", "money"),
      ];
      // One column per pay component, so "salary breakdown" is real columns rather than a blob. The lines are
      // the same ones the CTC annexure and the offer letter state (domain/payroll ctcLines).
      for (const c of await refPayComponents(deps)) {
        base.push(f(`component:${c.code}`, `${c.name} (monthly)`, "money"));
      }
      return base;
    }
    case "position":
      return [f("job_title", "Job title (current)", "text"), f("location", "Location", "text"), f("effective_from", "Role effective from", "date")];
    case "payslip":
      return [
        f("gross", "Payslip gross", "money"), f("taxable_gross", "Taxable gross", "money"),
        f("total_deductions", "Payslip deductions", "money"), f("tax", "Payslip tax", "money"),
        f("net", "Payslip net pay", "money"), f("period", "Pay period", "text"),
      ];
    case "leave": {
      // The org's own leave types, read through the per-request reference cache (lib/refData) rather than as
      // a query of this catalogue's own.
      const types = await refLeaveTypes(deps);
      return types.filter((t) => !t.deleteTime).map((t) => f(`type:${t.uuid}`, `${t.name} balance`, "number"));
    }
    case "asset":
      return [f("count", "Assets held", "number"), f("tags", "Asset tags", "text")];
    case "loan":
      return [f("outstanding", "Loan outstanding", "money"), f("monthly", "Loan EMI", "money"), f("count", "Open loans", "number")];
    case "benefit":
      return [f("plans", "Benefit plans", "text"), f("count", "Benefit enrollments", "number")];
    case "dependent":
      return [f("count", "Dependents", "number"), f("names", "Dependent names", "text")];
    case "tax":
      return [f("declared", "Declared (FY)", "money"), f("verified", "Verified (FY)", "money")];
    case "metric":
      // The people-analytics measures, unchanged: each keeps the collection that gates it and its own unit.
      return METRICS.map((m) => ({
        key: `${prefix}${SOURCE_PREFIX}metric.${m.key}`,
        label: m.label,
        group: `${group}: ${METRIC_GROUPS.find((g) => g.key === m.group)?.label ?? m.group}`,
        kind: (m.unit === "percent" || m.unit === "rating" ? "number" : m.unit === "days" || m.unit === "hours" || m.unit === "minutes" || m.unit === "count" ? "number" : "number") as FieldKind,
        collection: m.collection,
        needs: m.needs,
        path,
        source: "metric",
        leaf: m.key,
      }));
    default:
      return [];
  }
}

// ---- The catalogue --------------------------------------------------------------------------------------

/** What a link OFFERS: the collection it points at, and the path to ask for its fields. */
export type CatalogueLink = {
  /** Dotted wire path from the base (`employee_id`, `employee_id.department_id`), passed straight back. */
  path: string;
  /** What this link is on THIS row ("Requester", "Manager"). */
  label: string;
  collection: string;
  /** The target's own name ("People"), so the picker can say "Requester (People)". */
  collection_label: string;
};

/**
 * How many links deep a grid may follow. A to-one chain never fans out (one row in, one row out), so the cap
 * is about the reader rather than about cost: past four hops nobody can say what the column MEANS any more.
 */
export const MAX_LINK_DEPTH = 4;

/** A resolved hop of a link path: which column, which collection it lands on, and what to call it. */
type Hop = { column: string; wire: string; collection: string; label: string };

/**
 * Walk a dotted wire path from `base`, refusing at the first hop that is not a real link, points at something
 * this caller cannot list, or goes past the depth cap. Returns null for any of those - the caller answers with
 * an empty node rather than an error, because a path that stops being followable (a grant narrowed, a column
 * dropped) is a normal state of a saved view, not a fault.
 */
function walk(base: string, path: string[], listable: ReadonlySet<string>): Hop[] | null {
  if (path.length > MAX_LINK_DEPTH) return null;
  const hops: Hop[] = [];
  let collection = base;
  for (const seg of path) {
    const link = linksOf(collection).find((l) => l.wire === seg);
    if (!link || !listable.has(link.target)) return null;
    hops.push({ column: link.column, wire: link.wire, collection: link.target, label: humanize(link.column).replace(/ id$/i, "") });
    collection = link.target;
  }
  return hops;
}

/**
 * ONE node of the catalogue: the fields of the collection at `path`, plus the links leading out of it.
 *
 * The picker walks this like a file tree - "Tickets -> Requester (People) -> Department" - instead of being
 * handed every reachable field at once. That is what makes a join arbitrarily deep without the answer growing
 * combinatorially: a node costs its own columns, and nothing is computed for a link until somebody opens it.
 * The per-employee sources (identity, compensation, measures) hang off whichever node IS an employee, so
 * reaching a requester's PAN is opening the requester and finding it there.
 *
 * `path` is the dotted wire path from the base (empty for the base itself); every key this returns already
 * carries it, so a client stores what it is given and never composes a key.
 */
export async function buildCatalogue(
  deps: Deps,
  base: string,
  listable: ReadonlySet<string>,
  path: string[] = [],
  // The FIELD-level read gate, supplied by the layer allowed to run the engine (http/tableFieldAccess.ts
  // `catalogueFieldGate`). Absent means field-level access is not asked here - which is what `resolveFields`
  // wants, because the RUNNER decides those per row, on the row's own code, and a coarse answer must never be
  // what a saved view's columns are resolved against.
  canRead?: (field: { collection: string; subresource?: string; fieldKey?: string; wireName?: string }) => boolean,
): Promise<Catalogue> {
  const def = BASES[base];
  if (!def) throw new Error(`not a table base: ${base}`);
  const hops = walk(base, path, listable);
  if (!hops) return { base, label: def.label, path: path.join("."), groups: [], fields: [], links: [] };

  const collection = hops.length ? hops[hops.length - 1]!.collection : base;
  const jsPath = hops.map((h) => h.column);
  const prefix = path.length ? `${path.join(".")}.` : "";
  // What to call this node's own fields: the base's label at the root, and the trail of link names below it
  // ("Requester (People)", "Requester -> Department (Departments)").
  const trail = hops.map((h) => h.label).join(" -> ");
  const nodeLabel = hops.length ? `${trail} (${BASES[collection]!.label})` : def.label;
  // ...and the same trail as the LIST a header is qualified from. The picker files a field under the node it
  // came from, so standing in that node the plain name is enough and nothing here changes it; a grid puts
  // several nodes' columns in one row of headers, and domain/tableHeaders spends as much of this as that grid
  // turns out to need. The base's own fields carry none of it.
  const hopLabels = hops.map((h) => h.label);
  const qualify = (f: ResolvedField): ResolvedField => (hopLabels.length ? { ...f, trail: hopLabels } : f);

  const fields: ResolvedField[] = [];
  const groups: { key: string; label: string }[] = [];
  const addGroup = (key: string, label: string) => {
    if (!groups.some((g) => g.key === key)) groups.push({ key, label });
  };

  // A field the caller could never read on any row they can reach is not offered at all - the same promise the
  // collection filter above keeps one level up. `wireName` is the column as `policy.redacted_fields` spells it;
  // a source field is judged by its sub-resource instead, and one with neither is ungated.
  const allowed = (f: ResolvedField): boolean =>
    !canRead || canRead({ collection: f.collection, subresource: f.subresource, fieldKey: f.fieldKey, wireName: f.source ? undefined : f.key.split(".").pop()! });

  // 1. This node's own columns.
  const ownColumns = columnFields(collection, jsPath, nodeLabel, prefix).filter(allowed);
  // The group is added only if something lands in it - an empty heading is a promise of fields that are not there.
  if (ownColumns.length) addGroup(nodeLabel, nodeLabel);
  fields.push(...ownColumns.map(qualify));

  // 2. The per-employee sources, when this node IS an employee. A ticket's requester and its assignee are two
  //    different nodes, so each carries its own set and there is never a question of which one a column means.
  if (collection === "employees") {
    for (const src of SOURCES) {
      if (!listable.has(src.collection)) continue;
      if ((src.needs ?? []).some((n) => !listable.has(n))) continue;
      const built = await sourceFields(deps, src, jsPath, prefix, hops.length ? `${trail}: ${src.label}` : src.label);
      for (const fld of built) {
        if (!listable.has(fld.collection)) continue; // a measure's own collection
        if ((fld.needs ?? []).some((n) => !listable.has(n))) continue;
        if (!allowed(fld)) continue; // field-level read (a PII sub-resource, or one key within it)
        addGroup(fld.group, fld.group);
        fields.push(qualify(fld));
      }
    }
  }

  // 3. The links out of this node, as somewhere to GO rather than as fields.
  //
  // Repeats are allowed on purpose: "manager -> manager -> department" is a real question about a real
  // reporting line, and a rule that banned revisiting a collection would have taken `manager` off People (the
  // base is already an employee) - the one link people reach for first. The depth cap is what bounds it.
  const links: CatalogueLink[] =
    path.length >= MAX_LINK_DEPTH
      ? []
      : linksOf(collection)
          .filter((l) => listable.has(l.target))
          .map((l) => ({
            path: `${prefix}${l.wire}`,
            label: humanize(l.column).replace(/ id$/i, ""),
            collection: l.target,
            collection_label: BASES[l.target]!.label,
          }));

  return { base, label: def.label, path: path.join("."), nodeLabel, collection, groups, fields, links };
}

/**
 * Resolve the catalogue fields behind a set of saved keys, wherever in the join they live.
 *
 * The picker fetches one node at a time, so a saved view can hold keys from several nodes at once
 * (`first_name`, `department_id.name`, `employee_id.@identity.pan`). This walks each key's leading segments to
 * work out which node it belongs to, then builds ONLY those nodes - one per distinct path, not one per key.
 *
 * The walk is unambiguous: a segment is a link if the collection it is read against has a foreign key by that
 * wire name, a segment starting with the source prefix ends the walk, and whatever is left is the leaf. A key
 * whose node is unreachable (a grant narrowed, a link removed) simply resolves to nothing, and the run reports
 * it as a dropped column.
 */
export async function resolveFields(deps: Deps, base: string, listable: ReadonlySet<string>, keys: string[]): Promise<Map<string, ResolvedField>> {
  const paths = new Set<string>([""]);
  for (const key of keys) {
    let collection = base;
    const hops: string[] = [];
    for (const seg of key.split(".")) {
      if (seg.startsWith(SOURCE_PREFIX)) break;
      const link = linksOf(collection).find((l) => l.wire === seg);
      if (!link) break; // the leaf column of this node
      hops.push(seg);
      collection = link.target;
    }
    if (hops.length <= MAX_LINK_DEPTH) paths.add(hops.join("."));
  }
  const out = new Map<string, ResolvedField>();
  for (const path of paths) {
    const node = await buildCatalogue(deps, base, listable, path ? path.split(".") : []);
    for (const f of node.fields) out.set(f.key, f);
  }
  return out;
}

/**
 * The bases this caller may build on: registered, backed by a table, and REACHABLE by them.
 *
 * Reachable, not merely listable. Presence in the scope map is the boolean half of the verdict - "you may call
 * `GET /v1/<collection>`" - and a collection-level capability is routinely held by a caller whose breadth then
 * binds to nothing: own breadth on a table with no owner column, a principal with no employee record, a
 * dept-breadth caller with no department. `scopeCanMatch` asks the second half, and a base that could only
 * ever answer with an empty grid is not offered at all. Same rule the field catalogue already follows one
 * level down: a builder offers what the caller can have, never a menu of empty reports.
 */
export function basesFor(scopes: ReadonlyMap<string, ListScope>): { collection: string; label: string }[] {
  return Object.entries(BASES)
    .filter(([collection]) => {
      const table = TABLES[collection] as (SQLiteTable & Record<string, any>) | undefined;
      if (!table) return false;
      return scopeCanMatch(scopes.get(collection), table.code, listOwnerColumn(collection, table));
    })
    .map(([collection, def]) => ({ collection, label: def.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
