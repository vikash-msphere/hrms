import { useEffect, useMemo, useState } from "react";
import { CalendarSync, Sun } from "lucide-react";
import { create } from "@/api";
import { cn } from "@/lib/utils";
import { DOW } from "@/lib/leaveCalendar";
import { planYearCopy, type CopyRow } from "@/lib/holidayBulk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field, FieldRow } from "@/components/common/Field";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useDiscardGuard } from "@/hooks/useDiscardGuard";
import type { Holiday } from "@/types";

// "Next year looks a lot like this year" - true for most of a holiday calendar, and false in exactly the ways
// that matter: a fixed date lands on a different weekday, and a lunar/movable one doesn't follow the date at
// all. So this copies with the dates EDITABLE and flags every row that landed on a non-working day or already
// exists, rather than quietly writing twelve rows the admin then has to hunt through.

type Row = CopyRow & { take: boolean };

export function CopyYearDialog({ open, onOpenChange, holidays, years, workDays, defaultFrom, onDone }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  holidays: Holiday[];
  years: string[];
  workDays: number[];
  defaultFrom: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const guardClose = useDiscardGuard();
  // Hand-corrected dates are the expensive part of this dialog (a movable holiday's real date has to be looked
  // up), so once any row has been touched, closing asks first.
  const [touched, setTouched] = useState(false);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(String(Number(defaultFrom) + 1));
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const source = useMemo(
    () => holidays.filter((h) => !h.delete_time).map((h) => ({ date: h.date, name: h.display_name, kind: h.kind, half_day: h.half_day, location: h.location })),
    [holidays],
  );
  // Re-plan whenever the year pair changes; a duplicate starts unchecked so "copy again" is never destructive.
  useEffect(() => {
    if (!open) return;
    setRows(planYearCopy(source, from, to, workDays).map((r) => ({ ...r, take: !r.duplicate })));
    setTouched(false);
  }, [open, from, to, source, workDays]);

  const taking = rows.filter((r) => r.take);
  const setRow = (i: number, patch: Partial<Row>) => {
    // Only a hand-corrected DATE counts as work worth guarding; ticking rows on and off is a click to redo.
    if (patch.date !== undefined) setTouched(true);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  // A fixed date that lands on a Saturday buys nobody a day off. Most calendars answer that by observing the
  // holiday on the next working day, so offer that as one action over every row it applies to.
  const wastedCount = taking.filter((r) => r.wasted).length;
  const nextWorkDay = (ymd: string) => {
    let ms = Date.parse(ymd + "T00:00:00Z");
    for (let i = 0; i < 7; i++) {
      ms += 86400000;
      if (workDays.includes(new Date(ms).getUTCDay())) break;
    }
    return new Date(ms).toISOString().slice(0, 10);
  };
  function shiftWastedForward() {
    setTouched(true);
    setRows((rs) => rs.map((r) => (r.take && r.wasted ? { ...r, date: nextWorkDay(r.date), landsOn: new Date(Date.parse(nextWorkDay(r.date) + "T00:00:00Z")).getUTCDay(), wasted: false } : r)));
  }

  async function submit() {
    setBusy(true);
    setProgress(0);
    let failed = 0;
    for (const r of taking) {
      try {
        await create("holidays", { display_name: r.name, date: r.date, kind: r.kind, half_day: r.half_day, location: r.location });
      } catch {
        failed++;
      }
      setProgress((n) => n + 1);
    }
    setBusy(false);
    const added = taking.length - failed;
    toast({
      title: failed ? `${added} copied, ${failed} failed` : `Copied ${added} holiday${added === 1 ? "" : "s"} into ${to}`,
      variant: failed ? "destructive" : "success",
    });
    onDone();
    if (!failed) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={guardClose(touched && !busy, () => onOpenChange(false))}>
      {/* Height ceiling from `sm` up; a phone keeps the keyboard-aware sheet height (see ui/dialog.tsx).
          scrollBody rather than scrolling the whole panel: the list of holidays being copied is as long as
          the year is, and Copy has to stay reachable without scrolling to the end of it. */}
      <DialogContent scrollBody className="max-w-2xl sm:max-h-[90dvh] lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Copy a year of holidays</DialogTitle>
          <DialogDescription>
            Same month and day, one year on. Check the dates before copying - fixed dates move to a different
            weekday each year, and movable ones (Holi, Eid, Diwali) need the real date for the new year.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
        <FieldRow>
          <Field label="Copy from">
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {years.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Into">
            <Input value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" />
          </Field>
        </FieldRow>
        {rows.length === 0 ? (
          <p className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">Nothing in {from} to copy.</p>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-lg border">
            <table className="w-full text-sm">
              {/* One toggle for the whole list: a year is a dozen-plus rows, and "copy everything except two"
                  otherwise means a dozen clicks. */}
              <thead className="sticky top-0 border-b bg-card">
                <tr>
                  <th className="w-8 px-2 py-1.5">
                    <Checkbox
                      checked={taking.length === rows.length && rows.length > 0}
                      onCheckedChange={(v) => setRows((rs) => rs.map((r) => ({ ...r, take: v === true })))}
                      aria-label={taking.length === rows.length ? "Clear every holiday" : "Copy every holiday"}
                    />
                  </th>
                  <th colSpan={3} className="px-2 py-1.5 text-left text-xs font-medium text-muted-foreground">
                    {taking.length} of {rows.length} selected
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r, i) => (
                  <tr key={`${r.sourceDate}-${i}`} className={cn(!r.take && "opacity-50", r.wasted && r.take && "bg-warning/5")}>
                    <td className="w-8 px-2 py-1.5">
                      <Checkbox checked={r.take} onCheckedChange={(v) => setRow(i, { take: v === true })} aria-label={`Copy ${r.name}`} />
                    </td>
                    <td className="px-2 py-1.5">
                      <span className="font-medium">{r.name}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">was {r.sourceDate.slice(5)}</span>
                    </td>
                    <td className="w-36 px-2 py-1.5">
                      <Input
                        type="date"
                        value={r.date}
                        onChange={(e) => {
                          const date = e.target.value;
                          const dow = date ? new Date(Date.parse(date + "T00:00:00Z")).getUTCDay() : r.landsOn;
                          setRow(i, { date, landsOn: dow, wasted: !workDays.includes(dow) });
                        }}
                        className="h-8"
                      />
                    </td>
                    <td className="w-40 px-2 py-1.5 text-right">
                      <span className="inline-flex flex-wrap justify-end gap-1">
                        <Badge variant="muted">{DOW[r.landsOn]}</Badge>
                        {r.wasted && <Badge variant="warning"><Sun className="h-3 w-3" /> Not a working day</Badge>}
                        {r.duplicate && <Badge variant="secondary">Already in {to}</Badge>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {wastedCount > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            <span>{wastedCount} selected holiday{wastedCount === 1 ? "" : "s"} land{wastedCount === 1 ? "s" : ""} on a non-working day.</span>
            <Button size="sm" variant="outline" onClick={shiftWastedForward}>Move to the next working day</Button>
          </div>
        )}
        </DialogBody>
        <DialogFooter className="items-center">
          <p className="mr-auto text-xs text-muted-foreground">
            {busy ? `Copying ${progress} of ${taking.length}…` : `${taking.length} of ${rows.length} selected`}
          </p>
          <Button variant="outline" onClick={() => guardClose(touched, () => onOpenChange(false))(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={taking.length === 0 || !/^\d{4}$/.test(to)}>
            <CalendarSync className="h-4 w-4" /> Copy into {to}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
