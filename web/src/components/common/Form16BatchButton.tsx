import * as React from "react";
import { FileStack, Users } from "lucide-react";
import { invoke } from "@/api";
import { usePermission } from "@/lib/perm";
import { currentFy, fyOptions, fySpan } from "@/lib/fy";
import { runSequential, batchSummary, type BatchProgress } from "@/lib/batchRun";
import { idOf } from "@/lib/utils";
import { Field } from "@/components/common/Field";
import { WriteDialog } from "@/components/common/WriteDialog";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccessAction } from "@/components/access/AccessAction";
import { useToast } from "@/components/ui/use-toast";
import type { Department, DocumentResource, Employee } from "@/types";

/**
 * Form 16 for a whole year, for everyone.
 *
 * The per-employee button is the right shape for a leaver or a correction, and the wrong shape entirely for
 * June, when the same document is owed to the whole company. The verb is still one call per employee (each one
 * renders a PDF from that person's finalized payroll), so this walks the roster sequentially and reports who
 * it could not do - a year-end job that silently skipped four people would be worse than one that failed.
 */
export function Form16BatchButton({ employees, departments, loading = false, onGenerated }: {
  employees: Employee[];
  departments: Department[];
  /** Whether the roster is still being read. A count is the whole point of this dialog, and an unread roster
   *  is not a count of nought - "0 active employees" beside a disabled button reads as an empty company. */
  loading?: boolean;
  onGenerated?: () => void;
}) {
  const canGenerate = usePermission("personal-documents.write");
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [fy, setFy] = React.useState(currentFy());
  const [scope, setScope] = React.useState<"everyone" | "some">("everyone");
  const [picked, setPicked] = React.useState<string[]>([]);
  const [picking, setPicking] = React.useState(false);
  const [progress, setProgress] = React.useState<BatchProgress | null>(null);

  if (!canGenerate) return null;

  const active = employees.filter((e) => !e.disabled && !e.delete_time);
  // Rows already in hand answer even while the store revalidates; only an empty, unread roster is "counting".
  const counting = loading && employees.length === 0;
  const targets = scope === "everyone" ? active : active.filter((e) => picked.some((p) => idOf(p) === idOf(e.path)));
  const empName = (e: Employee) => `${e.first_name} ${e.last_name}`;

  async function run() {
    const result = await runSequential(
      targets,
      empName,
      // Through `invoke`, not the raw `api` helper: each call files a document, and only the write helpers
      // refresh the shared cache the lists of somebody's documents read from.
      (e) => invoke<DocumentResource>("personal-documents", "generateForm16", undefined, {
        employee: `employees/${idOf(e.path)}`,
        financial_year: fy,
      }),
      setProgress,
    );
    setProgress(null);
    onGenerated?.();
    if (result.failures.length) {
      // Thrown so the dialog stays open holding the list: usually a handful of people with no finalized payroll
      // for the year, which is a real answer, not a glitch.
      throw new Error(`${batchSummary(result, "Form 16")} Not done: ${result.failures.map((f) => `${f.label} (${f.message})`).join("; ")}`);
    }
    toast({ title: batchSummary(result, "Form 16"), description: `FY ${fy}, filed under each employee's documents.`, variant: "success" });
  }

  return (
    <>
      <AccessAction collection="personal-documents" verb="generateForm16" label="Generate Form 16">
        <Button variant="outline" onClick={() => { setFy(currentFy()); setScope("everyone"); setPicked([]); setOpen(true); }}>
          <FileStack className="h-4 w-4" /> Year-end Form 16
        </Button>
      </AccessAction>
      <WriteDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Form 16 for the year"
        description="One Form 16 (Part B) per employee, built from that year's finalized payroll and filed under their own documents. Nothing is downloaded."
        collection="personal-documents"
        guardLabel="Form 16 run"
        form={{ fy, scope, picked }}
        submitLabel={counting ? "Generate" : `Generate ${targets.length}`}
        canSubmit={targets.length > 0 && !counting}
        whyNot={counting ? "Still counting the roster." : "Nobody is selected."}
        onSubmit={run}
      >
        <Field label="Financial year" hint={`${fySpan(fy)}.${fy === currentFy() ? " This year is still running - figures cover the runs finalized so far." : ""}`}>
          <Select value={fy} onValueChange={setFy}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{fyOptions().map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field
          label="Who"
          hint={
            scope === "everyone"
              ? counting ? "Counting the roster…" : `${active.length} active ${active.length === 1 ? "employee" : "employees"}.`
              : `${picked.length} selected.`
          }
        >
          <div className="flex items-center gap-2">
            <Select value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
              <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="everyone">Every active employee</SelectItem>
                <SelectItem value="some">Specific people…</SelectItem>
              </SelectContent>
            </Select>
            {scope === "some" && (
              <Button type="button" variant="outline" onClick={() => setPicking(true)}>
                <Users className="h-4 w-4" /> {picked.length ? `${picked.length} selected` : "Choose people"}
              </Button>
            )}
          </div>
        </Field>
        {progress && (
          <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Generating {Math.min(progress.done + 1, progress.total)} of {progress.total}
            {progress.current ? ` - ${progress.current}` : ""}
            {progress.failures.length ? ` (${progress.failures.length} failed so far)` : ""}
          </p>
        )}
        {picking && (
          <EmployeePicker
            title="Form 16 for"
            confirmLabel="Select"
            employees={employees}
            departments={departments}
            onClose={() => setPicking(false)}
            onConfirm={(refs) => { setPicked(refs); setPicking(false); }}
          />
        )}
      </WriteDialog>
    </>
  );
}
