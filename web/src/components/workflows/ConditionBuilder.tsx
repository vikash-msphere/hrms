import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Comparison, CompareOp, Condition, MetaEventField, WorkflowMeta } from "./types";
import { isComparison } from "./types";

const NO_VALUE: CompareOp[] = ["exists", "notExists"];

// A flat all/any group of field·op·value rows (the 90% case). A hand-authored nested condition that doesn't fit
// this shape is left to the JSON toggle - we surface a note instead of silently dropping it.
export function ConditionBuilder({ meta, triggerType, value, onChange }: { meta: WorkflowMeta | null; triggerType: string; value: Condition | null; onChange: (c: Condition | null) => void }) {
  const parsed = parse(value);
  if (!parsed) {
    return <p className="text-sm text-muted-foreground">This condition is too complex to edit here - use the JSON toggle.</p>;
  }
  const { mode, rows } = parsed;
  const fields: { name: string; type?: MetaEventField["type"] }[] = [
    { name: "employeeId", type: "string" }, { name: "subject", type: "string" }, { name: "actorId", type: "string" },
    ...(meta?.events.find((e) => e.type === triggerType)?.fields ?? []).filter((f) => !["employeeId", "actorId", "subject"].includes(f.name)),
  ];
  // THE CATALOGUE ALREADY SAYS WHAT A FIELD IS, so the value box is typed by the FIELD rather than by how the
  // text happens to look. The server compares strictly in both directions (domain/automations.ts: `eq` is
  // `===` with no coercion, `gte` requires both sides to be numbers) and the validator checks a field's NAME
  // against the catalogue but never its value's type - so a mismatch saves cleanly, is listed, is enabled,
  // and then matches nothing forever, with no error at save time, none at evaluation, and nothing in the run
  // history beyond "did not fire". Typing a money threshold back the way this app displays it - `1,00,000` -
  // was enough: `Number()` gives NaN, the string is stored, and `gte` is false for every row ever submitted.
  const fieldType = new Map(fields.map((f) => [f.name, f.type]));
  const ops = meta?.conditionOps ?? ["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains", "exists", "notExists"];

  const emit = (m: "all" | "any", rs: Comparison[]) => onChange(rs.length === 0 ? null : ({ [m]: rs } as Condition));
  const setRow = (i: number, patch: Partial<Comparison>) => { const rs = rows.map((r, j) => (j === i ? { ...r, ...patch } : r)); emit(mode, rs); };
  const addRow = () => emit(mode, [...rows, { field: fields[0]?.name ?? "employeeId", op: "eq", value: "" }]);
  const delRow = (i: number) => emit(mode, rows.filter((_, j) => j !== i));

  return (
    <div className="space-y-2">
      {rows.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Match</span>
          <Select value={mode} onValueChange={(m) => emit(m as "all" | "any", rows)}>
            <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">all</SelectItem><SelectItem value="any">any</SelectItem></SelectContent>
          </Select>
          <span className="text-muted-foreground">of these</span>
        </div>
      )}
      {/* field / operator / value / remove. The two selects alone are 288px of stated width, so on a
          phone the row wraps into two lines rather than squeezing four controls into 328px. */}
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <Select value={r.field} onValueChange={(v) => setRow(i, { field: v })}>
            <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>{fields.map((f) => <SelectItem key={f.name} value={f.name}>{f.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={r.op} onValueChange={(v) => setRow(i, { op: v as CompareOp })}>
            <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{ops.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
          </Select>
          {!NO_VALUE.includes(r.op) && (
            <Input
              className="h-9 flex-1"
              value={String(r.value ?? "")}
              onChange={(e) => setRow(i, { value: coerce(e.target.value, fieldType.get(r.field)) })}
              placeholder="value"
              aria-invalid={badNumber(r.value, fieldType.get(r.field)) || undefined}
            />
          )}
          <Button type="button" variant="ghost" size="icon" aria-label="Remove this condition" onClick={() => delRow(i)}><X className="h-4 w-4" /></Button>
          {/* Said now rather than never: the server would accept this rule and then silently never fire it. */}
          {badNumber(r.value, fieldType.get(r.field)) && (
            <p className="w-full text-xs text-destructive">
              {r.field} is a number, and "{String(r.value)}" isn't one - this rule would save and then never match. Digits only, no symbols.
            </p>
          )}
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addRow}><Plus className="mr-1 h-4 w-4" /> Add condition</Button>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No condition - the rule runs on every {triggerType || "event"}.</p>}
    </div>
  );
}

// Numbers/booleans typed into the value box become real JSON values (so gt/lt compare numerically).
//
// `t` is the field's DECLARED type when the catalogue has one. Without it - a dotted payload path, or a field
// the running server does not describe - the old look-at-it guess is still the best available, and stays.
export function coerce(s: string, t?: MetaEventField["type"]): unknown {
  if (t === "string" || t === "ref" || t === "date") return s; // a numeric-looking asset tag is still a string
  if (t === "boolean") return s === "true";
  if (t === "number") {
    // Grouping separators are what a reader copies back off the screen (this app formats money en-IN).
    const n = Number(s.replace(/,/g, ""));
    return s.trim() === "" || Number.isNaN(n) ? s : n;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  // `Number(" ")` is 0, so a box holding a single space is not a number anybody typed.
  if (s.trim() !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

/** A `number` field whose box does not parse: the rule would save and then never match. */
export function badNumber(value: unknown, t?: MetaEventField["type"]): boolean {
  return t === "number" && typeof value !== "number";
}

function parse(c: Condition | null): { mode: "all" | "any"; rows: Comparison[] } | null {
  if (!c) return { mode: "all", rows: [] };
  if (isComparison(c)) return { mode: "all", rows: [c] };
  if ("all" in c && c.all.every(isComparison)) return { mode: "all", rows: c.all as Comparison[] };
  if ("any" in c && c.any.every(isComparison)) return { mode: "any", rows: c.any as Comparison[] };
  return null; // nested / not - not editable in the flat builder
}
