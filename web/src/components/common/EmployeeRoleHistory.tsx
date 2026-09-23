import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Briefcase, Plus } from "lucide-react";
import { getAllPages, create } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { humanize, idOf } from "@/lib/utils";
import { todayStr as todayYmd } from "@/lib/orgDay";
import type { Department, Position } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Field, FieldRow } from "@/components/common/Field";
import { TableSkeleton } from "@/components/common/Skeletons";
import { WriteDialog } from "@/components/common/WriteDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

const NONE = "__none__";
// Mirrors the enums the column and the requisition both use (src/services/positions.ts).
const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "intern", "temporary"] as const;
const WORK_MODES = ["on_site", "hybrid", "remote"] as const;

// Role history (designation / department / location) + a "Change role" action - the promotion/transfer
// analog of the compensation "Revise". A change is a new effective-dated row; the previously-current row is
// closed, and the employee's current designation/department are synced server-side. HR + super only.
export function EmployeeRoleHistory({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const [rows, setRows] = useState<Position[]>([]);
  const [cropped, setCropped] = useState(false); // the walk hit its ceiling: the timeline below is a window
  const reqSeq = useRef(0); // only the newest walk may write the rows (see `load`)
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ job_title: "", department: NONE, location: "", employment_type: NONE, work_mode: NONE, effective_from: todayYmd(), note: "" });

  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Unknown department" : "-");
  }, [departments]);

  // The loader is the effect's dependency (see the note in EmployeeBankDetails).
  const load = useCallback(async () => {
    // Several sequential round-trips, re-keyed on the person being viewed and called again after a role
    // change: only the newest walk may write (test/staleResponseDrift).
    const seq = ++reqSeq.current;
    try {
      // WALKED, not a raw `get()`: a bare list read sends no `max_page_size`, so the server's default of 50
      // applies (http/pagination.ts) and the response's cursor is thrown away. Positions are newest-first, so
      // a window loses the first role and the early promotions - the part a role history is opened for.
      const r = await getAllPages<Position>(`positions?employee=${encodeURIComponent("employees/" + employeeId)}`, 200);
      if (seq !== reqSeq.current) return;
      setRows(r.results);
      setCropped(r.truncated);
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't load role history", description: (e as Error).message });
    } finally {
      setLoaded(true);
    }
  }, [employeeId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const current = rows.find((r) => r.current);

  function openDialog() {
    setForm({
      job_title: current?.job_title ?? "",
      department: current?.department ? `departments/${idOf(current.department)}` : NONE,
      location: current?.location ?? "",
      employment_type: current?.employment_type ?? NONE,
      work_mode: current?.work_mode ?? NONE,
      effective_from: todayYmd(),
      note: "",
    });
    setOpen(true);
  }

  async function change() {
    await create("positions", {
      employee: "employees/" + employeeId,
      job_title: form.job_title.trim(),
      department: form.department === NONE ? "" : form.department,
      location: form.location.trim(),
      // `null` clears the column, NOT "": the route validates these against the enum, so an empty string is
      // rejected outright. `undefined` would mean something different again - carry the current value
      // forward - which is not what an explicitly emptied select means.
      employment_type: form.employment_type === NONE ? null : form.employment_type,
      work_mode: form.work_mode === NONE ? null : form.work_mode,
      effective_from: form.effective_from,
      note: form.note.trim(),
    });
    toast({ title: "Role updated" });
    await load();
  }

  // What this change actually moves, resolved against the row it supersedes - a promotion dialog that shows
  // only the new values leaves the reader to remember the old ones.
  const currentDept = current?.department ? `departments/${idOf(current.department)}` : NONE;
  const deltas: { label: string; from: string; to: string }[] = [];
  if ((form.job_title.trim() || "-") !== (current?.job_title ?? "-")) deltas.push({ label: "Designation", from: current?.job_title ?? "-", to: form.job_title.trim() || "-" });
  if (form.department !== currentDept) deltas.push({ label: "Department", from: deptName(current?.department), to: form.department === NONE ? "-" : deptName(form.department) });
  if ((form.location.trim() || "-") !== (current?.location ?? "-")) deltas.push({ label: "Location", from: current?.location ?? "-", to: form.location.trim() || "-" });
  if (form.employment_type !== (current?.employment_type ?? NONE)) deltas.push({ label: "Employment type", from: humanize(current?.employment_type ?? "-"), to: form.employment_type === NONE ? "-" : humanize(form.employment_type) });
  if (form.work_mode !== (current?.work_mode ?? NONE)) deltas.push({ label: "Work mode", from: humanize(current?.work_mode ?? "-"), to: form.work_mode === NONE ? "-" : humanize(form.work_mode) });
  // Effective before the row it would supersede: the history would read out of order, and "current" would be
  // decided by the wrong row. Worth blocking rather than warning.
  const backdated = !!current && !!form.effective_from && form.effective_from <= current.effective_from;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          <AccessAction collection="positions" label="Role history">
            <span className="flex items-center gap-2"><Briefcase className="h-4 w-4 text-primary" /> Role history</span>
          </AccessAction>
        </CardTitle>
        {canEdit && (
          <AccessAction collection="positions" create label="Change role">
            <Button size="sm" onClick={openDialog}><Plus className="h-4 w-4" /> Change role</Button>
          </AccessAction>
        )}
      </CardHeader>
      <CardContent>
        {!loaded ? (
          <TableSkeleton rows={3} cols={5} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No role history on record.{canEdit ? " Use Change role to record a promotion or transfer." : ""}</p>
        ) : (
          // Five columns of dates and names: one labelled row per change on a phone, a table from `sm` up
          // where the min-width keeps the columns legible instead of crushing them to one word each.
          <div className="scroll-shadow-x -mx-1 overflow-x-auto px-1 [--scroll-ground:hsl(var(--card))]">
          <table className="table-stack w-full text-sm sm:min-w-[30rem]">
            <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-medium">Effective</th><th className="py-2 pr-3 font-medium">Designation</th><th className="py-2 pr-3 font-medium">Department</th><th className="py-2 pr-3 font-medium">Location</th><th className="py-2 font-medium">Until</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path} className="border-b last:border-0">
                  <td data-label="Effective" className="whitespace-nowrap py-1.5 pr-3 font-medium">{r.effective_from}</td>
                  <td data-label="Designation" className="py-1.5 pr-3">{r.job_title ?? "-"}</td>
                  <td data-label="Department" className="py-1.5 pr-3">{deptName(r.department)}</td>
                  <td data-label="Location" className="py-1.5 pr-3">{r.location ?? "-"}</td>
                  <td data-label="Until" className="whitespace-nowrap py-1.5 text-muted-foreground">{r.current ? "current" : r.effective_to ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cropped && <p className="mt-2 text-xs text-muted-foreground">Showing the most recent roles - older ones are not loaded here.</p>}
          </div>
        )}
      </CardContent>

      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Change role"
        description="Records a promotion or transfer as a new dated row. Their live designation and department update to match, and the previous role closes on this date."
        collection="positions"
        guardLabel="role change"
        form={form}
        submitLabel="Save change"
        canSubmit={!!form.effective_from && !backdated && !(!!current && deltas.length === 0)}
        whyNot={
          !form.effective_from
            ? "Pick the date the change takes effect."
            : backdated
              ? `The effective date must be after the current role's start (${current?.effective_from}).`
              : current && deltas.length === 0
                ? "Nothing has changed yet - edit a field to record a move."
                : undefined
        }
        onSubmit={change}
      >
          <FieldRow>
            <Field label="Designation"><Input value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} placeholder="e.g. Senior Engineer" autoFocus /></Field>
            <Field
              label="Effective from"
              error={backdated ? `Must be after the current role's start (${current?.effective_from}).` : undefined}
              hint={!backdated && current ? `Closes the role that began ${current.effective_from}.` : undefined}
            >
              <Input type="date" min={current?.effective_from} value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label="Department">
              <Select value={form.department} onValueChange={(v) => setForm({ ...form, department: v })}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>None</SelectItem>
                  {departments.filter((d) => !d.disabled).map((d) => (
                    <SelectItem key={d.path} value={`departments/${idOf(d.path)}`}>{d.display_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Location (optional)"><Input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="e.g. office city" /></Field>
          </FieldRow>
          {/* Effective-dated with the rest of the role: converting a contract to permanent, or moving someone
              to hybrid, is a change with a date - not an attribute to overwrite in place. */}
          <FieldRow>
            <Field label="Employment type (optional)">
              <Select value={form.employment_type} onValueChange={(v) => setForm({ ...form, employment_type: v })}>
                <SelectTrigger><SelectValue placeholder="Not set" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not set</SelectItem>
                  {EMPLOYMENT_TYPES.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Work mode (optional)">
              <Select value={form.work_mode} onValueChange={(v) => setForm({ ...form, work_mode: v })}>
                <SelectTrigger><SelectValue placeholder="Not set" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not set</SelectItem>
                  {WORK_MODES.map((m) => <SelectItem key={m} value={m}>{humanize(m)}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
          <Field label="Note (optional)" hint="Reason for the change, e.g. Promotion, Transfer."><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          {current && (
            <div className="rounded-lg border bg-muted/40 p-3 text-sm">
              {deltas.length === 0 ? (
                <span className="text-muted-foreground">Nothing changes yet - edit a field above to record a move.</span>
              ) : (
                <dl className="space-y-1">
                  {deltas.map((d) => (
                    <div key={d.label} className="flex flex-wrap items-baseline gap-x-2">
                      <dt className="text-muted-foreground">{d.label}</dt>
                      <dd className="flex items-baseline gap-1.5">
                        <span className="text-muted-foreground line-through">{d.from}</span>
                        <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="font-medium">{d.to}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
      </WriteDialog>
    </Card>
  );
}
