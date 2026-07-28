import { useEffect, useMemo, useState } from "react";
import { Briefcase, Plus } from "lucide-react";
import { get, create } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import type { Department, Position } from "@/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/common/Field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const todayYmd = () => new Date().toISOString().slice(0, 10);
const NONE = "__none__";

// Role history (designation / department / location) + a "Change role" action - the promotion/transfer
// analog of the compensation "Revise". A change is a new effective-dated row; the previously-current row is
// closed, and the employee's current designation/department are synced server-side. HR + super only.
export function EmployeeRoleHistory({ employeeId, canEdit }: { employeeId: string; canEdit: boolean }) {
  const { toast } = useToast();
  const { rows: departments } = useCollection<Department>("departments");
  const [rows, setRows] = useState<Position[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ job_title: "", department: NONE, location: "", effective_from: todayYmd(), note: "" });
  const [busy, setBusy] = useState(false);

  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "-");
  }, [departments]);

  async function load() {
    try {
      const r = await get<{ results: Position[] }>(`positions?employee=${encodeURIComponent("employees/" + employeeId)}`);
      setRows(r.results ?? []);
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't load role history", description: (e as Error).message });
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    void load();
  }, [employeeId]);

  const current = rows.find((r) => r.current);

  function openDialog() {
    setForm({
      job_title: current?.job_title ?? "",
      department: current?.department ? `departments/${idOf(current.department)}` : NONE,
      location: current?.location ?? "",
      effective_from: todayYmd(),
      note: "",
    });
    setOpen(true);
  }

  async function change() {
    setBusy(true);
    try {
      await create("positions", {
        employee: "employees/" + employeeId,
        job_title: form.job_title.trim() || null,
        department: form.department === NONE ? null : form.department,
        location: form.location.trim() || null,
        effective_from: form.effective_from,
        note: form.note.trim() || null,
      });
      toast({ title: "Role updated" });
      setOpen(false);
      await load();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't update role", description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
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
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No role history on record.{canEdit ? " Use Change role to record a promotion or transfer." : ""}</p>
        ) : (
          <table className="w-full text-sm">
            <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2 pr-3 font-medium">Effective</th><th className="py-2 pr-3 font-medium">Designation</th><th className="py-2 pr-3 font-medium">Department</th><th className="py-2 pr-3 font-medium">Location</th><th className="py-2 font-medium">Until</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 font-medium">{r.effective_from}</td>
                  <td className="py-1.5 pr-3">{r.job_title ?? "-"}</td>
                  <td className="py-1.5 pr-3">{deptName(r.department)}</td>
                  <td className="py-1.5 pr-3">{r.location ?? "-"}</td>
                  <td className="py-1.5 text-muted-foreground">{r.current ? "current" : r.effective_to ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.effective_from) change(); }}>
          <DialogHeader><DialogTitle>Change role</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Record a promotion or transfer, effective from a date you choose. Their designation and department update to match.</p>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Designation"><Input value={form.job_title} onChange={(e) => setForm({ ...form, job_title: e.target.value })} placeholder="e.g. Senior Engineer" autoFocus /></Field>
            <Field label="Effective from"><Input type="date" value={form.effective_from} onChange={(e) => setForm({ ...form, effective_from: e.target.value })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
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
          </div>
          <Field label="Note (optional)" hint="Reason for the change, e.g. Promotion, Transfer."><Input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={change} loading={busy} disabled={!form.effective_from}>Save change</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
