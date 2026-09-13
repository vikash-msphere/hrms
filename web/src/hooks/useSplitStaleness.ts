import { useCallback, useEffect, useState } from "react";
import { invoke } from "@/api";
import { usePermission } from "@/lib/perm";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

type SplitStatus = { stale: number; unchanged: number; skipped: number };
type ReapplyResult = { updated: number; unchanged: number; skipped: number };
const ZERO: SplitStatus = { stale: 0, unchanged: 0, skipped: 0 };

// Shared "employee salary splits are out of date" machinery, used by every panel that edits a split INPUT -
// pay components, salary structures, and the CTC provisions. The split (each employee's cached basic + Special
// Allowance, annual CTC held fixed) is derived from the live component catalog + structure lines + ctc config,
// so a change to any of them can affect the stored splits. A server dry-run
// (compensation:reapplySplit { dry_run: true }) classifies every current row two ways that need DIFFERENT
// action, both of which this hook surfaces (the old code only ever looked at `stale`, so a cost-increasing
// change that tipped rows into `skipped` went completely silent):
//   stale   - the split moved but the CTC still fits; a re-apply fixes these.
//   skipped - the change pushed committed cost PAST the employee's fixed CTC, so no split fits. Re-apply can't
//             fix these - HR must raise the CTC or trim components. Surfaced as a distinct warning.
// Only reapply-capable callers (payroll/super) can read/act on it - anyone else gets an advisory toast.
// `auto` (default true) does the status dry-run on mount, for callers that RENDER the banner. Callers that only
// want to prompt after a change pass false: the dry-run re-solves every current compensation row, so mounting it
// on a page that never shows the count would just spend queries (two hooks on one profile = two of them).
export function useSplitStaleness({ auto = true }: { auto?: boolean } = {}) {
  const canReapply = usePermission("compensation.reapplySplit");
  const { toast } = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<SplitStatus>(ZERO);
  const [reapplying, setReapplying] = useState(false);

  const dryRun = useCallback(async (): Promise<SplitStatus> => {
    const s = await invoke<SplitStatus>("compensation", "reapplySplit", undefined, { dry_run: true });
    return { stale: s.stale ?? 0, unchanged: s.unchanged ?? 0, skipped: s.skipped ?? 0 };
  }, []);

  const refresh = useCallback(async () => {
    if (!canReapply) return;
    try {
      setStatus(await dryRun());
    } catch { /* advisory only - never block the page */ }
  }, [canReapply, dryRun]);

  useEffect(() => { if (auto) void refresh(); }, [auto, refresh]);

  /**
   * Re-solve every employee's split from their stored CTC.
   *
   * RETURNS WHETHER IT WORKED. It still swallows the failure into a toast (callers that only offer the
   * re-apply have nothing better to do with it), but a caller that SEQUENCES something after it has to be able
   * to stop: `PayrollRuns#reapplyAndRebuild` ran the rebuild regardless, re-pricing the run off exactly the
   * drifted rows the button exists to correct, and the operator saw a red "Couldn't re-apply" followed by a
   * green "Run rebuilt" with the drift banner cleared over figures that were never fixed.
   */
  const reapply = useCallback(async (): Promise<boolean> => {
    setReapplying(true);
    try {
      const r = await invoke<ReapplyResult>("compensation", "reapplySplit");
      toast({
        title: "Splits re-applied",
        description: `${r.updated} updated, ${r.unchanged} unchanged${r.skipped ? `, ${r.skipped} skipped - their CTC no longer fits the components, so nothing was changed; raise the CTC or trim components` : ""}.`,
        variant: r.skipped ? "destructive" : "success",
      });
      await refresh();
      return true;
    } catch (e) {
      toast({ title: "Couldn't re-apply", description: (e as Error).message, variant: "destructive" });
      return false;
    } finally {
      setReapplying(false);
    }
  }, [refresh, toast]);

  // Offer to propagate right after a change that shifts the CTC build-up. Prompts when anything moved - stale
  // (re-applyable) OR skipped (needs a CTC fix reapply can't make, so we still surface it). Non-reapply callers
  // get an advisory toast. Returns silently only when nothing at all changed.
  const promptReapply = useCallback(async () => {
    if (!canReapply) {
      toast({ title: "Employee splits may be out of date", description: "This changes the CTC build-up. Ask Payroll to re-apply the split to existing employees." });
      return;
    }
    const s = await dryRun();
    setStatus(s);
    if (s.stale === 0 && s.skipped === 0) return;
    const skippedNote = s.skipped
      ? ` ${s.skipped} employee${s.skipped === 1 ? "'s" : "s'"} CTC no longer fits the components - re-apply can't fix ${s.skipped === 1 ? "it" : "those"}; raise the CTC or trim components.`
      : "";
    if (s.stale === 0) {
      // Only infeasible rows - nothing to re-apply, just warn so the change isn't silently swallowed.
      toast({ title: "Some employees' CTC no longer fits", description: skippedNote.trim(), variant: "destructive" });
      return;
    }
    const ok = await confirm({
      title: "Re-apply the split to existing employees?",
      description: `This change affects the CTC build-up. ${s.stale} employee${s.stale === 1 ? "'s" : "s'"} basic / special-allowance split ${s.stale === 1 ? "is" : "are"} now out of date (each employee's annual CTC stays fixed). Re-apply now?${skippedNote}`,
      confirmLabel: "Re-apply now",
    });
    if (ok) await reapply();
  }, [canReapply, confirm, toast, reapply, dryRun]);

  return {
    canReapply,
    staleCount: status.stale,
    skippedCount: status.skipped,
    reapplying,
    refresh,
    reapply,
    promptReapply,
  };
}
