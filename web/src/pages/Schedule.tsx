import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { get, create, patch, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { cn, idOf } from "@/lib/utils";
import type { Department, Employee, Me, Shift, ShiftAssignment } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const DAY = 86_400_000;
// Local calendar date - toISOString() would shift local midnight into the previous UTC day
// (in IST the whole week grid would be labeled one day off).
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function mondayOf(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // back to Monday
  return x;
}
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayNum = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function Schedule({ me }: { me: Me }) {
  const { rows: shifts, state: shiftsState } = useCollection<Shift>("shifts");
  const { rows: employees, state: employeesState } = useCollection<Employee>("employees");
  const { rows: departments, state: departmentsState } = useCollection<Department>("departments");
  const { toast } = useToast();
  // The roster has its own error handling; these three feed the filters/pickers. Surface a lookup failure so
  // an empty dropdown reads as "couldn't load" rather than "nothing here".
  useEffect(() => {
    if (shiftsState === "error" || employeesState === "error" || departmentsState === "error")
      toast({ title: "Couldn't load some schedule options", description: "Filters may be incomplete. Try reloading.", variant: "destructive" });
  }, [shiftsState, employeesState, departmentsState, toast]);
  const canManage = usePermission("shift-assignments.write");

  const [dept, setDept] = useState("all");
  const [shiftFilter, setShiftFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => ymd(new Date(+weekStart + i * DAY))), [weekStart]);
  const [assignments, setAssignments] = useState<ShiftAssignment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<{ employee: string; date: string; existing?: ShiftAssignment } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await get<{ results: ShiftAssignment[] }>(`shift-assignments?from=${days[0]}&to=${days[6]}&max_page_size=500`);
      setAssignments(r.results ?? []);
    } catch (e) {
      toast({ title: "Couldn't load the roster", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoaded(true);
    }
  }, [days[0], days[6]]);
  useEffect(() => { void load(); }, [load]);

  const shiftById = useMemo(() => new Map(shifts.map((s) => [idOf(s.path), s])), [shifts]);
  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);
  // (employeeId|date) -> assignment
  const byCell = useMemo(() => {
    const m = new Map<string, ShiftAssignment>();
    for (const a of assignments) if (a.employee && a.date) m.set(`${idOf(a.employee)}|${a.date}`, a);
    return m;
  }, [assignments]);

  // employeeId -> set of shiftIds assigned in the visible week (for the shift filter).
  const shiftsByEmp = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!a.employee || !a.shift) continue;
      const k = idOf(a.employee);
      (m.get(k) ?? m.set(k, new Set()).get(k)!).add(idOf(a.shift));
    }
    return m;
  }, [assignments]);

  // Rows: managers/HR see everyone (to assign); others see only people who already have an assignment (themselves).
  const rows = useMemo(() => {
    const assigned = new Set(assignments.map((a) => idOf(a.employee ?? "")));
    const base = canManage
      ? [...employees].sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`))
      : employees.filter((e) => assigned.has(idOf(e.path)));
    const q = search.trim().toLowerCase();
    return base.filter((e) => {
      if (dept !== "all" && !(e.department && idOf(e.department) === dept)) return false;
      if (shiftFilter !== "all" && !shiftsByEmp.get(idOf(e.path))?.has(shiftFilter)) return false;
      if (q && !`${e.first_name} ${e.last_name} ${e.employee_number ?? ""} ${e.job_title ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [employees, assignments, canManage, dept, shiftFilter, search, shiftsByEmp]);

  function openCell(employeePath: string, date: string) {
    if (!canManage) return;
    const existing = byCell.get(`${idOf(employeePath)}|${date}`);
    setEditing({ employee: `employees/${idOf(employeePath)}`, date, existing });
  }

  // Coverage per day - "how many people are on" is the first thing a scheduler checks.
  const countByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assignments) if (a.date) m.set(a.date, (m.get(a.date) ?? 0) + 1);
    return m;
  }, [assignments]);

  const weekLabel = `${dayNum(days[0])} - ${dayNum(days[6])}`;
  const filtersActive = dept !== "all" || shiftFilter !== "all" || search.trim() !== "";
  const today = ymd(new Date());

  return (
    <div>
      <PageHeader title="Schedule" description={canManage ? "Click any cell to assign or change a shift." : undefined} actions={<PageSettings me={me} host="schedule" />} />

      <div className="mb-4 flex items-center gap-2">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => new Date(+w - 7 * DAY))} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></Button>
        <span className="min-w-[12rem] text-center text-sm font-medium tabular-nums">{weekLabel}</span>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setWeekStart((w) => new Date(+w + 7 * DAY))} aria-label="Next week"><ChevronRight className="h-4 w-4" /></Button>
        <Button variant="ghost" size="sm" onClick={() => setWeekStart(mondayOf(new Date()))}>This week</Button>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people…" className="h-8 w-40" />
          {departments.length > 0 && (
            <Select value={dept} onValueChange={setDept}>
              <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All departments</SelectItem>
                {departments.filter((d) => !d.delete_time).map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          {shifts.length > 0 && (
            <Select value={shiftFilter} onValueChange={setShiftFilter}>
              <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All shifts</SelectItem>
                {shifts.map((s) => <SelectItem key={s.path} value={idOf(s.path)}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {!loaded ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          illustration={filtersActive ? "noResults" : "schedule"}
          title={filtersActive ? "No matches" : "Nothing scheduled"}
          description={filtersActive ? "No people match the current filters." : canManage ? "Assign shifts to build the roster. Define shifts in Settings → Time off." : "You have no shifts scheduled this week."}
        />
      ) : (
        <>
          {/* Legend: which colour is which shift, so the grid reads at a glance. */}
          {shifts.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {shifts.map((s) => (
                <span key={s.path} className="inline-flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color ?? "#64748b" }} />
                  <span className="font-medium text-foreground">{s.name}</span>
                  <span className="tabular-nums">{s.start}-{s.end}</span>
                </span>
              ))}
            </div>
          )}
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="sticky left-0 z-10 w-[240px] bg-muted/40 px-3 py-2 text-left font-medium">Employee</th>
                  {days.map((d, i) => (
                    <th key={d} className={cn("px-2 py-2 text-center font-medium", d === today && "text-primary")}>
                      <div>{WEEKDAY[i]}</div>
                      <div className="text-xs font-normal tabular-nums text-muted-foreground">{dayNum(d)}</div>
                      {canManage && <div className="text-[10px] font-normal tabular-nums text-muted-foreground">{countByDay.get(d) ?? 0} on</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.path} className="border-b last:border-0">
                    <td className="sticky left-0 z-10 max-w-[240px] truncate border-r bg-card px-3 py-2 font-medium">{e.first_name} {e.last_name}</td>
                    {days.map((d) => {
                      const a = byCell.get(`${idOf(e.path)}|${d}`);
                      const s = a?.shift ? shiftById.get(idOf(a.shift)) : undefined;
                      return (
                        <td key={d} className={cn("border-r p-1 last:border-0 align-top", d === today && "bg-primary/5")}>
                          <button
                            type="button"
                            disabled={!canManage}
                            onClick={() => openCell(e.path, d)}
                            className={cn(
                              "group flex h-12 w-full flex-col items-center justify-center rounded-md px-1 text-xs transition-colors",
                              a ? "font-medium" : "text-muted-foreground",
                              canManage ? "cursor-pointer hover:ring-1 hover:ring-primary/40" : "cursor-default",
                              !a && canManage && "hover:bg-muted/50",
                            )}
                            style={a ? { backgroundColor: (s?.color ?? "#64748b") + "22", color: s?.color ?? undefined } : undefined}
                          >
                            {a ? (
                              <>
                                <span className="truncate">{s?.name ?? "Shift"}</span>
                                {s && <span className="tabular-nums opacity-80">{s.start}-{s.end}</span>}
                              </>
                            ) : canManage ? <span className="opacity-0 transition-opacity group-hover:opacity-100">+</span> : ""}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {editing && (
        <AssignDialog
          employeeName={empName(editing.employee)}
          date={editing.date}
          existing={editing.existing}
          shifts={shifts}
          onClose={() => setEditing(null)}
          onSave={async (shiftRef, note) => {
            try {
              if (editing.existing) await patch(`shift-assignments/${idOf(editing.existing.path)}`, { shift: shiftRef, note: note || null }, editing.existing.etag);
              else await create("shift-assignments", { employee: editing.employee, shift: shiftRef, date: editing.date, note: note || undefined });
              toast({ title: editing.existing ? "Shift updated" : "Shift assigned", variant: "success" });
              setEditing(null); load();
            } catch (e) { toast({ title: "Couldn't save the assignment", description: (e as Error).message, variant: "destructive" }); }
          }}
          onRemove={editing.existing ? async () => {
            try {
              await remove(`shift-assignments/${idOf(editing.existing!.path)}`);
              toast({ title: "Assignment removed", variant: "success" });
              setEditing(null); load();
            } catch (e) { toast({ title: "Couldn't remove the assignment", description: (e as Error).message, variant: "destructive" }); }
          } : undefined}
        />
      )}
    </div>
  );
}

const dayFull = (s: string) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function AssignDialog({ employeeName, date, existing, shifts, onClose, onSave, onRemove }: {
  employeeName: string;
  date: string;
  existing?: ShiftAssignment;
  shifts: Shift[];
  onClose: () => void;
  onSave: (shiftRef: string, note: string) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const [shift, setShift] = useState(existing?.shift ? `shifts/${idOf(existing.shift)}` : "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const busy = saving || removing;
  const save = async () => { setSaving(true); try { await onSave(shift, note.trim()); } finally { setSaving(false); } };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent onEnterSubmit={() => { if (!busy && shift) save(); }}>
        <DialogHeader><DialogTitle>{existing ? "Edit shift" : "Assign shift"}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground"><span className="font-medium text-foreground">{employeeName}</span> · {dayFull(date)}</p>
        <Field label="Shift">
          {shifts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No shifts defined. Add some in Settings → Time off → Shifts.</p>
          ) : (
            <Select value={shift} onValueChange={setShift}>
              <SelectTrigger><SelectValue placeholder="Choose a shift…" /></SelectTrigger>
              <SelectContent>
                {shifts.map((s) => <SelectItem key={s.path} value={`shifts/${idOf(s.path)}`}>{s.name} ({s.start}-{s.end})</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <DialogFooter className="items-center">
          {onRemove && (
            <Button variant="ghost" size="sm" className="mr-auto text-destructive" loading={removing} disabled={saving}
              onClick={async () => { setRemoving(true); try { await onRemove(); } finally { setRemoving(false); } }}>
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={save} loading={saving} disabled={!shift || removing}>{existing ? "Save" : "Assign"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
