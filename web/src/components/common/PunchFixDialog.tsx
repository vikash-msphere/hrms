import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { useDiscardGuard } from "@/hooks/useDiscardGuard";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn, formatDate } from "@/lib/utils";
import {
  fmtHM24, fmtMinOfDay, hhmmToMin, punchErrors, punchTotal, seedPunches, signedDuration,
  type AttendanceRow, type PunchRow, type PunchTarget,
} from "@/lib/attendance";

// The attendance correction dialog. A correction changes ONE thing: this clock-in, or that clock-out, of one
// day's log - or, on a day with no punches at all, that day's one in/out. What it files is what the server
// takes (services/attendanceRegularizations.ts): the day's full intended set of sessions, built here from the
// recorded day with just that change, so the person only ever looks at the time that is wrong. A fixed time is
// checked against the punches either side of it, and the error names the neighbour it runs into. A clock-out
// that was never punched is the same dialog with nothing recorded.

const REASONS = {
  in: ["Forgot to clock in", "Clocked in late", "Device or network issue"],
  out: ["Forgot to clock out", "Clocked out late", "Device or network issue"],
  add: ["Forgot to clock in and out", "Device or network issue"],
};

const hm12 = (hhmm: string) => fmtMinOfDay(hhmmToMin(hhmm));

export function PunchFixDialog({ row, punch, tz, today, pendingDays, busy, onClose, onSubmit }: {
  row: AttendanceRow;
  // The punch being fixed. Omitted on a day with no punches, where the request adds the day's in/out instead.
  punch?: PunchTarget;
  tz: string;
  // The org-local today: only then may a clock-out stay blank (still at work), and no time may pass now.
  today: string;
  pendingDays: string[];
  busy: boolean;
  onClose: () => void;
  // Files the day's intended punches (pages/Attendance.tsx). Resolves to a failure message to pin beside the form.
  onSubmit: (day: string, punches: PunchRow[], reason: string) => Promise<string | undefined>;
}) {
  const guardClose = useDiscardGuard();
  const seeded = seedPunches(row.summary?.sessions ?? [], tz);
  const target = punch ? seeded[punch.index] : undefined;
  const recorded = target && punch ? target[punch.edge] : "";
  const [value, setValue] = useState(recorded);
  const [added, setAdded] = useState<PunchRow>({ in: "", out: "" });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isToday = row.day === today;
  const open = isToday ? { now: fmtHM24(new Date().toISOString(), tz) } : undefined;
  const next: PunchRow[] = punch ? seeded.map((r, i) => (i === punch.index ? { ...r, [punch.edge]: value } : r)) : [added];
  const missing = punch?.edge === "out" && !recorded; // a clock-out that was never punched
  const changed = punch ? value !== recorded : !!(added.in || added.out);

  // The punches either side of the one being fixed, which is what it can run into.
  const prev = punch ? seeded[punch.index - 1] : undefined;
  const after = punch ? seeded[punch.index + 1] : undefined;
  const bound = (): string | undefined => {
    if (!punch) {
      const err = punchErrors(next, open)[0];
      if (err) return err;
      if (open && (added.in > open.now || added.out > open.now)) return "Can't be later than now";
      return undefined;
    }
    // A blank time is only ever today's latest clock-out left running; the day's rules below say whether it is.
    if (!value) return missing && !isToday ? "Add the time you clocked out" : punchErrors(next, open).find(Boolean);
    if (punch.edge === "in") {
      if (prev?.out && value <= prev.out) return `Must be after your ${hm12(prev.out)} clock-out`;
      if (target?.out && value >= target.out) return `Must be before your ${hm12(target.out)} clock-out`;
    } else {
      if (target && value <= target.in) return `Must be after your ${hm12(target.in)} clock-in`;
      if (after?.in && value >= after.in) return `Must be before your ${hm12(after.in)} clock-in`;
    }
    if (open && value > open.now) return "Can't be later than now";
    // Whatever the neighbours allow, the day as a whole still has to be a valid request.
    return punchErrors(next, open).find(Boolean);
  };
  const problem = changed ? bound() : undefined;
  const canSubmit = (punch ? !!target : !!added.in) && changed && !problem;
  // The difference to worked time, the number the approver is really deciding on.
  const delta = canSubmit ? punchTotal(next, open) - punchTotal(seeded, open) : 0;
  const stillIn = isToday && (punch ? punch.edge === "out" && !value : !!added.in && !added.out);
  // The added in/out has two fields; the error is painted on the one it is about.
  const badIn = !punch && !!problem && (!added.in || problem.startsWith("Clock-in"));
  const badOut = !punch && !!problem && !badIn;
  const clash = pendingDays.includes(row.day);
  const dirty = changed || !!reason.trim();
  const close = () => guardClose(dirty, onClose)(false);

  const submit = async () => {
    // `busy` as well as validity: Enter fires from the inputs, and a second one in flight would file twice.
    if (!canSubmit || busy) return;
    setError(null);
    const failure = await onSubmit(row.day, next.filter((r) => r.in || r.out), reason.trim());
    if (failure) setError(failure);
  };

  const title = !punch ? (isToday ? "Add missing clock-in" : "Add missing punches")
    : missing ? "Add missing clock-out" : punch.edge === "in" ? "Fix clock-in" : "Fix clock-out";
  const description = !punch
    ? isToday
      ? "When did you clock in? Still at work? Leave the clock-out blank and clock out as usual. Your manager or HR approves it."
      : "When did you clock in and out? Your manager or HR approves it."
    : `Only this ${punch.edge === "in" ? "clock-in" : "clock-out"} changes; the rest of the day stays as recorded. Your manager or HR approves it.`;

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) close(); }}>
      <DialogContent scrollBody onEnterSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{title} · {formatDate(row.day)}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody>

        {/* The day's log, with the punch being fixed marked, so it is obvious which one this is. */}
        {punch && (
          <div className="flex flex-wrap gap-1.5 text-xs tabular-nums" aria-label="The day's punches">
            {seeded.map((r, i) => {
              const mark = (edge: "in" | "out") => i === punch.index && edge === punch.edge;
              const cell = (edge: "in" | "out", t: string) => (
                <span className={cn(mark(edge) && "rounded bg-primary/10 px-1 font-semibold text-primary")}>
                  {t ? hm12(t) : edge === "out" && isToday ? "still in" : "no clock-out"}
                </span>
              );
              return (
                <span key={i} className={cn("flex items-center gap-1 rounded-md border px-2 py-1", i === punch.index ? "border-primary/40" : "text-muted-foreground")}>
                  {cell("in", r.in)} <span aria-hidden>→</span> {cell("out", r.out)}
                </span>
              );
            })}
          </div>
        )}

        {clash && (
          <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
            This day already has a correction awaiting approval. Filing again queues a second one - cancel the pending one under My correction requests if you meant to change it.
          </p>
        )}

        {punch ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">Recorded</p>
              <p className="flex h-9 items-center text-sm tabular-nums">{recorded ? hm12(recorded) : <span className="text-warning">Not punched</span>}</p>
            </div>
            <Field label="Should be">
              <Input
                type="time"
                aria-invalid={!!problem}
                className={cn(problem && "border-destructive focus-visible:ring-destructive")}
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Clock in">
              <Input
                type="time"
                aria-invalid={badIn}
                className={cn(badIn && "border-destructive focus-visible:ring-destructive")}
                autoFocus
                value={added.in}
                onChange={(e) => setAdded({ ...added, in: e.target.value })}
              />
            </Field>
            <Field label="Clock out">
              <Input
                type="time"
                aria-invalid={badOut}
                className={cn(badOut && "border-destructive focus-visible:ring-destructive")}
                value={added.out}
                onChange={(e) => setAdded({ ...added, out: e.target.value })}
              />
            </Field>
          </div>
        )}
        <div className="-mt-1 min-h-4 text-xs">
          {problem ? (
            <p className="font-medium text-destructive">{problem}</p>
          ) : stillIn ? (
            <p className="font-medium text-success">Still clocked in - clock out as usual.</p>
          ) : delta !== 0 ? (
            <p className="tabular-nums text-muted-foreground">
              <span className={cn("font-medium", delta > 0 ? "text-success" : "text-warning")}>{signedDuration(delta)}</span> worked time
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Field label="Reason" hint="Your manager or HR reads this when approving.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What happened?" />
          </Field>
          {/* The usual answers, one press each; the text stays editable after. */}
          <div className="flex flex-wrap gap-1.5">
            {REASONS[punch?.edge ?? "add"].map((r) => (
              <Button key={r} type="button" variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => setReason(r)}>{r}</Button>
            ))}
          </div>
        </div>
        <FormError error={error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button loading={busy} disabled={!canSubmit} onClick={submit}>Submit request</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
