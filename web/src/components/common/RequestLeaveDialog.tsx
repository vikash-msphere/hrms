import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { create, get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, idOf } from "@/lib/utils";
import { chargeableDays } from "@/lib/leaveDays";
import type { Employee, Holiday, LeaveBalance, LeaveRequest, LeaveType, Me } from "@/types";
import type { LeaveDraft } from "@/lib/leaveDraft";
import { Field, FieldRow } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const upper = (s?: string) => (s ?? "").toUpperCase();

// The "request leave" form, extracted so the Leaves page and the dashboard timeline share one implementation.
// Self-contained: it fetches the data it needs (types, balances, holidays, peers' requests, working week), so
// callers only supply the viewer, an initial date/session draft, and an onSubmitted callback. Mount it only
// while open (e.g. `{open && <RequestLeaveDialog .../>}`) so it fetches nothing until used.
export function RequestLeaveDialog({
  open,
  onOpenChange,
  me,
  initial,
  onSubmitted,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  me: Me;
  initial?: LeaveDraft | null;
  onSubmitted?: () => void;
}) {
  const { rows: types } = useCollection<LeaveType>("leave-types");
  const { rows: balances } = useCollection<LeaveBalance>("leave-balances");
  const { rows: holidays } = useCollection<Holiday>("holidays");
  const { rows: requests } = useCollection<LeaveRequest>("leave-requests");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();

  const [workDays, setWorkDays] = useState<number[]>([1, 2, 3, 4, 5]);
  useEffect(() => {
    get<{ value?: { work_days?: number[] } }>("settings/attendance")
      .then((s) => { if (Array.isArray(s.value?.work_days) && s.value.work_days.length) setWorkDays(s.value.work_days); })
      .catch(() => {});
  }, []);
  const holidaySet = useMemo(() => new Set(holidays.filter((h) => !h.disabled).map((h) => h.date.slice(0, 10))), [holidays]);

  // Org policy: when back-dating is disallowed, the date pickers can't go before today (server enforces it too).
  const [allowBackdated, setAllowBackdated] = useState(true);
  useEffect(() => {
    get<{ value?: { allow_backdated?: boolean } }>("settings/leave-requests")
      .then((s) => { if (typeof s.value?.allow_backdated === "boolean") setAllowBackdated(s.value.allow_backdated); })
      .catch(() => {});
  }, []);
  const minDate = allowBackdated ? undefined : new Date().toLocaleDateString("en-CA");

  // Sessions: 1 = first half (morning), 2 = second half (afternoon). Defaults 1/2 = full days.
  const [form, setForm] = useState({ leave_type: "", start_date: "", end_date: "", reason: "", startSession: 1, endSession: 2 });
  // Seed the dates/sessions whenever the dialog (re)opens with a draft.
  useEffect(() => {
    if (open) setForm((f) => ({ ...f, start_date: initial?.from ?? f.start_date, end_date: initial?.to ?? f.end_date, startSession: initial?.startSession ?? 1, endSession: initial?.endSession ?? 2 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.from, initial?.to, initial?.startSession, initial?.endSession]);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Someone" : "Someone");
  }, [employees]);

  const [busy, setBusy] = useState(false);

  const formDays = chargeableDays(form.start_date, form.end_date, form.startSession, form.endSession, workDays, holidaySet);
  const rangeInverted = !!form.start_date && !!form.end_date && form.end_date < form.start_date;
  // How many calendar days in the range are weekends/holidays (not charged) - shown so the total isn't a surprise.
  const skippedDays = useMemo(() => {
    if (!form.start_date || !form.end_date || rangeInverted) return 0;
    const span = Math.round((Date.parse(form.end_date + "T00:00:00Z") - Date.parse(form.start_date + "T00:00:00Z")) / 86400000) + 1;
    const working = chargeableDays(form.start_date, form.end_date, 1, 2, workDays, holidaySet) ?? span;
    return span - working;
  }, [form.start_date, form.end_date, rangeInverted, workDays, holidaySet]);

  const balanceByType = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of balances) if (me.employee_id && b.employee && idOf(b.employee) === me.employee_id && b.leave_type) m.set(idOf(b.leave_type), b.balance_days);
    return m;
  }, [balances, me.employee_id]);
  const availableFor = (t: LeaveType): number | null => (t.paid ? (balanceByType.get(idOf(t.path)) ?? 0) : null);
  const selectedType = types.find((t) => form.leave_type && idOf(t.path) === idOf(form.leave_type));
  const selectedAvail = selectedType ? availableFor(selectedType) : null;
  const insufficient = selectedAvail != null && formDays != null && formDays > selectedAvail + 1e-9;

  const deptOf = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), e.department]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) : undefined);
  }, [employees]);
  const myDept = me.employee_id ? deptOf(`employees/${me.employee_id}`) : undefined;
  const overlaps = useMemo(() => {
    if (!form.start_date || !form.end_date || !myDept) return [];
    return requests
      .filter(
        (lr) =>
          lr.employee &&
          idOf(lr.employee) !== me.employee_id &&
          (upper(lr.state) === "APPROVED" || upper(lr.state) === "PENDING") &&
          deptOf(lr.employee) === myDept &&
          lr.start_date <= form.end_date &&
          lr.end_date >= form.start_date,
      )
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [requests, deptOf, myDept, form.start_date, form.end_date, me.employee_id]);

  // The caller's OWN pending/approved leave that would double-book any day in the range. Session-aware:
  // a morning half and an afternoon half of the same day don't clash, so "take the other half" still works.
  const typeLabel = useMemo(() => {
    const m = new Map(types.map((t) => [idOf(t.path), t.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Leave" : "Leave");
  }, [types]);
  const myConflicts = useMemo(() => {
    if (!form.start_date || !form.end_date || !me.employee_id || form.end_date < form.start_date) return [];
    const nS = form.start_date, nE = form.end_date;
    return requests
      .filter((lr) => {
        if (!lr.employee || idOf(lr.employee) !== me.employee_id) return false;
        const st = upper(lr.state);
        if (st !== "APPROVED" && st !== "PENDING") return false;
        const eS = lr.start_date.slice(0, 10), eE = lr.end_date.slice(0, 10);
        const o1 = eS > nS ? eS : nS, o2 = eE < nE ? eE : nE;
        if (o1 > o2) return false; // no shared days
        if (o1 < o2) return true; // 2+ shared days always clash
        // Exactly one shared day: clash only if the session ranges on that day intersect.
        const a1 = eS === o1 ? (lr.start_session ?? 1) : 1, a2 = eE === o1 ? (lr.end_session ?? 2) : 2;
        const b1 = nS === o1 ? form.startSession : 1, b2 = nE === o1 ? form.endSession : 2;
        return a1 <= b2 && b1 <= a2;
      })
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
  }, [requests, me.employee_id, form.start_date, form.end_date, form.startSession, form.endSession]);

  const canSubmit = !!form.leave_type && !!form.start_date && !!form.end_date && !!formDays && !insufficient && myConflicts.length === 0;

  async function submit() {
    setBusy(true);
    try {
      await create("leave-requests", {
        leave_type: form.leave_type,
        start_date: form.start_date,
        end_date: form.end_date,
        start_session: form.startSession,
        end_session: form.endSession,
        reason: form.reason || null,
      });
      toast({ title: "Leave requested", variant: "success" });
      setForm({ leave_type: "", start_date: "", end_date: "", reason: "", startSession: 1, endSession: 2 });
      onOpenChange(false);
      onSubmitted?.();
    } catch (e) {
      toast({ title: "Couldn't request leave", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onEnterSubmit={() => { if (!busy && canSubmit) submit(); }}>
        <DialogHeader>
          <DialogTitle>Request leave</DialogTitle>
        </DialogHeader>
        <Field label="Leave type">
          <Select value={form.leave_type} onValueChange={(v) => setForm({ ...form, leave_type: v })}>
            <SelectTrigger><SelectValue placeholder="Select a type…" /></SelectTrigger>
            <SelectContent>
              {types.filter((t) => !t.disabled).map((t) => {
                const avail = availableFor(t);
                const lacks = avail != null && formDays != null && formDays > avail + 1e-9;
                return (
                  <SelectItem key={t.path} value={`leave-types/${idOf(t.path)}`} disabled={lacks}>
                    {t.display_name}{avail != null ? ` · ${avail} left` : ""}{lacks ? " - not enough balance" : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </Field>
        <FieldRow>
          <Field label="Start date">
            <Input
              type="date"
              min={minDate}
              value={form.start_date}
              // Picking a start auto-fills the end (single-day is the common case) and drags a now-stale end along.
              onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, start_date: v, end_date: !f.end_date || f.end_date < v ? v : f.end_date })); }}
            />
          </Field>
          <Field label="End date" error={rangeInverted ? "End date is before the start date." : undefined}>
            <Input type="date" min={form.start_date || minDate} value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          </Field>
        </FieldRow>
        {form.start_date && form.start_date === form.end_date ? (
          <Field label="Duration">
            <Select
              value={form.startSession === 1 && form.endSession === 2 ? "full" : form.startSession === 1 ? "am" : "pm"}
              onValueChange={(v) => setForm({ ...form, startSession: v === "pm" ? 2 : 1, endSession: v === "am" ? 1 : 2 })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full day</SelectItem>
                <SelectItem value="am">First half (morning)</SelectItem>
                <SelectItem value="pm">Second half (afternoon)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        ) : form.start_date && form.end_date && form.end_date > form.start_date ? (
          <FieldRow>
            <Field label="First day">
              <Select value={String(form.startSession)} onValueChange={(v) => setForm({ ...form, startSession: Number(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">Full day</SelectItem>
                  <SelectItem value="2">Second half (afternoon)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Last day">
              <Select value={String(form.endSession)} onValueChange={(v) => setForm({ ...form, endSession: Number(v) })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="2">Full day</SelectItem>
                  <SelectItem value="1">First half (morning)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
        ) : null}
        {myConflicts.length > 0 && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="font-medium text-destructive">You already have leave on these dates</p>
            <ul className="mt-1 space-y-1">
              {myConflicts.map((lr) => (
                <li key={lr.path} className="flex items-center justify-between gap-2">
                  <span>{typeLabel(lr.leave_type)}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDate(lr.start_date)} - {formatDate(lr.end_date)}{upper(lr.state) === "PENDING" ? " · pending" : ""}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-xs text-muted-foreground">Change the dates, or cancel the existing request first.</p>
          </div>
        )}
        {overlaps.length > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <p className="mb-1.5 flex items-center gap-1.5 font-medium text-warning-foreground dark:text-warning"><Users className="h-4 w-4" /> Also off in your department</p>
            <ul className="space-y-1">
              {overlaps.map((lr) => (
                <li key={lr.path} className="flex items-center justify-between gap-2">
                  <span>{empName(lr.employee)}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatDate(lr.start_date)}–{formatDate(lr.end_date)}{upper(lr.state) === "PENDING" ? " · pending" : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label="Reason (optional)">
          <Textarea rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
        </Field>
        {formDays === 0 ? (
          <p className="text-sm text-warning-foreground dark:text-warning">No working days in this range - weekends and holidays aren't counted. Pick a working day.</p>
        ) : insufficient ? (
          <p className="text-sm text-destructive">Not enough balance: this needs {formDays} day{formDays === 1 ? "" : "s"} but only {selectedAvail} left.</p>
        ) : formDays != null ? (
          <p className="text-sm text-muted-foreground">
            Total: <span className="font-medium text-foreground">{formDays} day{formDays === 1 ? "" : "s"}</span>
            {skippedDays > 0 ? <> (skips {skippedDays} weekend/holiday day{skippedDays === 1 ? "" : "s"})</> : null}
            {selectedAvail != null ? <> · {Math.round((selectedAvail - formDays) * 2) / 2} of {selectedAvail} day{selectedAvail === 1 ? "" : "s"} left after this</> : null}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>Request leave</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
