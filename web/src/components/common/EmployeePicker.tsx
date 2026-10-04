import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { idOf } from "@/lib/utils";
import type { Department, Employee } from "@/types";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/common/SearchInput";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const empRef = (e: Employee) => `employees/${idOf(e.path)}`;

// A filtered multi-select of employees (department + name search), as a modal. Used to pick review-cycle
// participants and to nominate 360 feedback givers. `exclude` drops employees that shouldn't be selectable.
// `suggested` (ranked employee refs) floats likely picks to the top and offers them as one-click chips.
export function EmployeePicker({ title, confirmLabel, employees, departments, exclude, suggested, suggestedWhy, initial, onClose, onConfirm }: {
  title: string;
  confirmLabel: string;
  employees: Employee[];
  departments: Department[];
  exclude?: string[]; // employee refs to omit (e.g. the reviewee, already-picked)
  suggested?: string[]; // employee refs, best first (e.g. same team, recent collaborators)
  // Why each suggestion is there, keyed by employee id: "3 tasks together · exchanged kudos". A suggestion
  // with its reason attached is a fact somebody can weigh; without one it is the app asking to be trusted.
  suggestedWhy?: Record<string, string>;
  /** Already-picked refs, for a picker that EDITS a set rather than adding to one (removing a name withdraws it). */
  initial?: string[];
  onClose: () => void;
  onConfirm: (refs: string[]) => void;
}) {
  const [dept, setDept] = useState("all");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set((initial ?? []).map((r) => idOf(r))));
  const excluded = useMemo(() => new Set((exclude ?? []).map((r) => idOf(r))), [exclude]);
  const suggestedRank = useMemo(() => new Map((suggested ?? []).map((r, i) => [idOf(r), i])), [suggested]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = employees.filter((e) => {
      if (excluded.has(idOf(e.path))) return false;
      if (dept !== "all" && (!e.department || idOf(e.department) !== idOf(dept))) return false;
      if (needle && !`${e.first_name} ${e.last_name}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    if (!suggestedRank.size) return rows;
    return rows.sort((a, b) => (suggestedRank.get(idOf(a.path)) ?? Infinity) - (suggestedRank.get(idOf(b.path)) ?? Infinity));
  }, [employees, dept, q, excluded, suggestedRank]);
  const suggestedRows = useMemo(
    () => (suggested ?? []).map((ref) => employees.find((e) => idOf(e.path) === idOf(ref))).filter((e): e is Employee => !!e && !excluded.has(idOf(e.path))).slice(0, 6),
    [suggested, employees, excluded],
  );
  const allShown = filtered.length > 0 && filtered.every((e) => picked.has(empRef(e)));
  const toggle = (ref: string) => setPicked((s) => { const n = new Set(s); n.has(ref) ? n.delete(ref) : n.add(ref); return n; });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={dept} onValueChange={setDept}>
            <SelectTrigger className="h-9 w-48"><SelectValue placeholder="Department" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.filter((d) => !d.delete_time).map((d) => <SelectItem key={d.path} value={d.path}>{d.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name…" className="h-9 pl-8" />
          </div>
        </div>
        {suggestedRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Suggested:</span>
            {suggestedRows.map((e) => {
              const ref = empRef(e);
              const on = picked.has(ref);
              return (
                // A toggle says so with `aria-pressed`, and keeps the person's name as its whole accessible
                // name: with the ✓/+ glyph in the name instead, the chip answers to a different label
                // depending on whether it is on, which is no name at all to a screen reader and no handle to
                // anything driving the page.
                <button
                  key={e.path}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(ref)}
                  title={suggestedWhy?.[idOf(e.path)]}
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent"}`}
                >
                  <span aria-hidden="true">{on ? "✓ " : "+ "}</span>{e.first_name} {e.last_name}
                </button>
              );
            })}
          </div>
        )}
        {/* The reasons, spelled out rather than hidden in a tooltip: on a phone there is no hover, and the
            reason is the part that decides whether the suggestion is any good. */}
        {suggestedWhy && suggestedRows.some((e) => suggestedWhy[idOf(e.path)]) && (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {suggestedRows.filter((e) => suggestedWhy[idOf(e.path)]).map((e) => (
              <li key={e.path}><span className="font-medium text-foreground">{e.first_name} {e.last_name}</span> - {suggestedWhy[idOf(e.path)]}</li>
            ))}
          </ul>
        )}
        <div className="max-h-72 space-y-0.5 overflow-y-auto rounded-lg border p-1.5">
          <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm font-medium hover:bg-accent">
            <Checkbox checked={allShown} onCheckedChange={(v) => setPicked((s) => { const n = new Set(s); filtered.forEach((e) => v ? n.add(empRef(e)) : n.delete(empRef(e))); return n; })} />
            Select all shown ({filtered.length})
          </label>
          <div className="my-1 border-t" />
          {filtered.length === 0 ? (
            <p className="px-1.5 py-2 text-sm text-muted-foreground">No matching employees.</p>
          ) : filtered.map((e) => (
            <label key={e.path} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
              <Checkbox checked={picked.has(empRef(e))} onCheckedChange={() => toggle(empRef(e))} />
              {e.first_name} {e.last_name}
            </label>
          ))}
        </div>
        <DialogFooter className="items-center">
          {picked.size > 0 && <span className="mr-auto text-sm text-muted-foreground">{picked.size} selected</span>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {/* A picker that EDITS a set may legitimately be emptied - removing every name withdraws them all -
              where one that ADDS to a set has nothing to do with no names in it. */}
          <Button onClick={() => onConfirm([...picked])} disabled={picked.size === 0 && !initial}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
