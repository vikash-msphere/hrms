import { useMemo, useState } from "react";
import { AlertTriangle, ListPlus } from "lucide-react";
import { create } from "@/api";
import { cn } from "@/lib/utils";
import { dmy } from "@/lib/leaveCalendar";
import { parseHolidayLines, type HolidayDraft } from "@/lib/holidayBulk";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useDiscardGuard } from "@/hooks/useDiscardGuard";

// Seed a year in one paste. The list is parsed as you type and shown back as rows, because the failure mode
// worth designing against is not a rejected line - it is a line that parsed into the wrong date and got created
// anyway. Nothing is written until the preview looks right.

const EXAMPLE = `2026-01-26  Republic Day
2026-03-04, Holi, optional
26/12/2026 | Christmas Eve | half day | Mumbai`;

export function BulkAddDialog({ open, onOpenChange, existingDates, onDone }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Dates already in the calendar, so the preview can say "you already have this one". */
  existingDates: Set<string>;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const guardClose = useDiscardGuard();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);

  const parsed = useMemo(() => parseHolidayLines(text), [text]);
  const drafts = useMemo(
    () => parsed.flatMap((p) => (p.draft && !existingDates.has(p.draft.date) ? [p.draft] : [])),
    [parsed, existingDates],
  );
  const problems = parsed.filter((p) => p.error);
  const already = parsed.filter((p) => p.draft && existingDates.has(p.draft.date));

  async function submit() {
    setBusy(true);
    setProgress(0);
    const failed: { draft: HolidayDraft; message: string }[] = [];
    // Sequential on purpose: the batch transport is read-only, and a tidy failure list beats a fast stampede
    // that leaves the calendar half-written with no way to tell which lines landed.
    for (const draft of drafts) {
      try {
        await create("holidays", {
          display_name: draft.name,
          date: draft.date,
          kind: draft.kind,
          half_day: draft.half_day,
          location: draft.location,
        });
      } catch (e) {
        failed.push({ draft, message: (e as Error).message });
      }
      setProgress((n) => n + 1);
    }
    setBusy(false);
    const added = drafts.length - failed.length;
    if (failed.length === 0) {
      toast({ title: `Added ${added} holiday${added === 1 ? "" : "s"}`, variant: "success" });
      setText("");
      onOpenChange(false);
    } else {
      toast({
        title: `${added} added, ${failed.length} failed`,
        description: failed.slice(0, 3).map((f) => `${f.draft.date}: ${f.message}`).join(" · "),
        variant: "destructive",
      });
      // Leave the failures in the box so they can be fixed and re-submitted; drop what succeeded.
      setText(failed.map((f) => `${f.draft.date}  ${f.draft.name}`).join("\n"));
    }
    onDone();
  }

  // A pasted-in year of holidays is a lot of work to lose to a stray click on the backdrop.
  return (
    <Dialog open={open} onOpenChange={guardClose(text.trim() !== "" && !busy, () => onOpenChange(false))}>
      {/* Height ceiling from `sm` up; a phone keeps the keyboard-aware sheet height (see ui/dialog.tsx). */}
      <DialogContent className="flex max-w-2xl flex-col overflow-y-auto sm:max-h-[90dvh] lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add many holidays</DialogTitle>
          <DialogDescription>
            One per line: date first, then the name. Add <code>optional</code>, <code>half day</code> or a
            location in any order, separated by commas, tabs or <code>|</code>. Lines starting with{" "}
            <code>#</code> are ignored.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={EXAMPLE}
          rows={8}
          className="font-mono text-xs"
          autoFocus
        />
        {/* The format is easier to copy than to read: one click puts a working example in the box, where the
            live preview below then explains what each part did. */}
        {text.trim() === "" && (
          <button
            type="button"
            onClick={() => setText(EXAMPLE)}
            className="-mt-2 self-start text-xs font-medium text-primary hover:underline"
          >
            Fill in the example to edit
          </button>
        )}
        {parsed.length > 0 && (
          <div className="max-h-64 overflow-y-auto rounded-lg border">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {parsed.map((p) => {
                  const dupe = p.draft && existingDates.has(p.draft.date);
                  return (
                    <tr key={p.line} className={cn(p.error && "bg-destructive/5", dupe && "bg-muted/40")}>
                      <td className="w-10 px-2 py-1.5 text-right text-xs tabular-nums text-muted-foreground">{p.line}</td>
                      {p.error ? (
                        <td className="px-2 py-1.5 text-xs text-destructive" colSpan={3}>
                          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                          {p.error} - <span className="font-mono">{p.raw}</span>
                        </td>
                      ) : (
                        <>
                          <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{dmy(p.draft!.date)}</td>
                          <td className="px-2 py-1.5">{p.draft!.name}</td>
                          <td className="px-2 py-1.5 text-right">
                            <span className="inline-flex flex-wrap justify-end gap-1">
                              {p.draft!.kind === "optional" && <Badge variant="warning">Optional</Badge>}
                              {p.draft!.half_day && <Badge variant="info">Half day</Badge>}
                              {p.draft!.location && <Badge variant="secondary">{p.draft!.location}</Badge>}
                              {dupe && <Badge variant="muted">Already added - skipped</Badge>}
                            </span>
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter className="items-center">
          <p className="mr-auto text-xs text-muted-foreground">
            {busy
              ? `Adding ${progress} of ${drafts.length}…`
              : `${drafts.length} to add` +
                (already.length ? ` · ${already.length} already there` : "") +
                (problems.length ? ` · ${problems.length} line${problems.length === 1 ? "" : "s"} to fix` : "")}
          </p>
          <Button variant="outline" onClick={() => guardClose(text.trim() !== "", () => onOpenChange(false))(false)} disabled={busy}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={drafts.length === 0}>
            <ListPlus className="h-4 w-4" /> Add {drafts.length || ""} holiday{drafts.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
