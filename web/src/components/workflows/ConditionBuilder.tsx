import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Comparison, CompareOp, Condition, WorkflowMeta } from "./types";
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
  const fields = [
    { name: "employeeId" }, { name: "subject" }, { name: "actorId" },
    ...(meta?.events.find((e) => e.type === triggerType)?.fields ?? []).filter((f) => !["employeeId", "actorId", "subject"].includes(f.name)),
  ];
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
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Select value={r.field} onValueChange={(v) => setRow(i, { field: v })}>
            <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>{fields.map((f) => <SelectItem key={f.name} value={f.name}>{f.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={r.op} onValueChange={(v) => setRow(i, { op: v as CompareOp })}>
            <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{ops.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
          </Select>
          {!NO_VALUE.includes(r.op) && (
            <Input className="h-9 flex-1" value={String(r.value ?? "")} onChange={(e) => setRow(i, { value: coerce(e.target.value) })} placeholder="value" />
          )}
          <Button type="button" variant="ghost" size="icon" onClick={() => delRow(i)}><X className="h-4 w-4" /></Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addRow}><Plus className="mr-1 h-4 w-4" /> Add condition</Button>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No condition - the rule runs on every {triggerType || "event"}.</p>}
    </div>
  );
}

// Numbers/booleans typed into the value box become real JSON values (so gt/lt compare numerically).
function coerce(s: string): unknown {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

function parse(c: Condition | null): { mode: "all" | "any"; rows: Comparison[] } | null {
  if (!c) return { mode: "all", rows: [] };
  if (isComparison(c)) return { mode: "all", rows: [c] };
  if ("all" in c && c.all.every(isComparison)) return { mode: "all", rows: c.all as Comparison[] };
  if ("any" in c && c.any.every(isComparison)) return { mode: "any", rows: c.any as Comparison[] };
  return null; // nested / not - not editable in the flat builder
}
