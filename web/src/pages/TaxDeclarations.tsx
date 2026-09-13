import { Fragment, useMemo, useRef, useState } from "react";
import { FileCheck, Plus, Pencil, Trash2, Check, X, Paperclip, Download } from "lucide-react";
import { create, patch, remove, invoke, upload, download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatMoney, idOf } from "@/lib/utils";
import { useOrg, useMoney, currencyDecimals } from "@/lib/org";
import { fyOptions } from "@/lib/fy";
import type { Employee, Me, TaxDeclaration, TaxDeclarationStatus } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { useKpiFocus } from "@/lib/kpiFocus";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { FormError } from "@/components/common/FormError";
import { MoneyInput } from "@/components/common/MoneyInput";
import { useDialogGuard } from "@/components/common/dialogGuard";
import { AccessScope } from "@/components/access/AccessScope";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const SECTIONS = ["80C", "80CCD(1B)", "80D", "80E", "80G", "80TTA", "HRA", "Home loan interest", "Other"];
const STATUS: Record<TaxDeclarationStatus, { label: string; variant: "secondary" | "success" | "destructive" }> = {
  DECLARED: { label: "Declared", variant: "secondary" },
  VERIFIED: { label: "Verified", variant: "success" },
  REJECTED: { label: "Rejected", variant: "destructive" },
};
export default function TaxDeclarations({ me, openId }: { me: Me; openId?: string }) {
  // This year and the last one: a declaration is filed for the running year, or amended for the year just past.
  // Resolved at RENDER, not at module load: the year comes from the org's calendar day (lib/orgDay.ts), whose
  // timezone hydrates from the settings snapshot - a module-level const is computed before that lands and,
  // unlike a render-time read, never corrects itself.
  const FY_OPTIONS = useMemo(() => fyOptions(1), []);
  const { rows, state, error, reload } = useCollection<TaxDeclaration>("tax-declarations");
  const { rows: employees } = useCollection<Employee>("employees", { all: true });
  const { toast } = useToast();
  const confirm = useConfirm();
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [fy, setFy] = useState(FY_OPTIONS[0]);
  const [dialog, setDialog] = useState<TaxDeclaration | "new" | null>(null);
  const [verifying, setVerifying] = useState<TaxDeclaration | null>(null);
  useDeepOpen(openId, rows, setDialog);
  const uploadFor = useRef<TaxDeclaration | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);
  const mine = (d: TaxDeclaration) => !!d.employee && idOf(d.employee) === me.employee_id;
  const inYear = useMemo(() => rows.filter((d) => d.financial_year === fy).sort((a, b) => a.section.localeCompare(b.section)), [rows, fy]);
  const totalDeclared = inYear.reduce((s, d) => s + d.declared_amount, 0);
  const totalVerified = inYear.reduce((s, d) => s + (d.status === "VERIFIED" ? (d.verified_amount ?? 0) : 0), 0);
  const awaiting = inYear.filter((d) => d.status === "DECLARED").length;
  const rejected = inYear.filter((d) => d.status === "REJECTED").length;
  // A declaration with no proof attached is the one that gets rejected later, so it earns its own metric.
  const noProof = inYear.filter((d) => !d.has_proof && d.status !== "VERIFIED").length;
  const kf = useKpiFocus<TaxDeclaration, "all" | "verified" | "awaiting" | "rejected" | "noProof">({
    all: { label: "declarations", match: () => true },
    verified: { label: "verified declarations", match: (d) => d.status === "VERIFIED" },
    awaiting: { label: "declarations awaiting verification", match: (d) => d.status === "DECLARED" },
    rejected: { label: "rejected declarations", match: (d) => d.status === "REJECTED" },
    noProof: { label: "declarations with no proof attached", match: (d) => !d.has_proof && d.status !== "VERIFIED" },
  });
  const items = useMemo(() => kf.apply(inYear), [inYear, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps
  // Declarations grouped by section (items are section-sorted, so Map keeps first-seen order).
  const groups = useMemo(() => {
    const by = new Map<string, TaxDeclaration[]>();
    for (const d of items) {
      const g = by.get(d.section);
      if (g) g.push(d);
      else by.set(d.section, [d]);
    }
    return [...by.entries()];
  }, [items]);
  // Whether the table needs an "Employee" column (a manager/HR seeing others' rows).
  const showOwner = items.some((d) => !mine(d));

  // Throws on failure: the dialog catches it and pins the reason inside the form, where it can be read while
  // the amount is being corrected.
  async function save(body: Record<string, unknown>, existing: TaxDeclaration | null) {
    if (existing) await patch(`tax-declarations/${idOf(existing.path)}`, body, existing.etag);
    else await create("tax-declarations", { ...body, financial_year: fy });
    toast({ title: existing ? "Updated" : "Declared", variant: "success" });
    setDialog(null); reload();
  }
  // `rethrow` is for callers inside a dialog: they show the reason in the form instead of a toast that would
  // land behind the dialog, and they must not close on a failure the user never got to read.
  async function act(d: TaxDeclaration, verb: "verify" | "reject", body?: Record<string, unknown>, rethrow = false) {
    try {
      // THE ETag OF THE ROW THAT WAS READ. Verifying a declaration accepts a figure that reduces withholding,
      // and the employee may edit their own declaration (and replace its proof) until it is verified - so the
      // decision has to be pinned to the version on screen. A row that moved comes back 409 and the message
      // says to look again, instead of quietly verifying an amount nobody reviewed.
      await invoke(`tax-declarations/${idOf(d.path)}`, verb, d.etag, body);
      toast({ title: verb === "verify" ? "Declaration verified" : "Declaration rejected", variant: "success" });
      reload();
    } catch (e) {
      if (rethrow) throw e;
      toast({ title: verb === "verify" ? "Couldn't verify the declaration" : "Couldn't reject the declaration", description: (e as Error).message, variant: "destructive" });
    }
  }
  async function reject(d: TaxDeclaration) {
    if (!(await confirm({ title: `Reject the ${d.section} declaration?`, description: "The employee can edit it to fix the problem - saving resubmits it for verification.", destructive: true, confirmLabel: "Reject" }))) return;
    void act(d, "reject");
  }
  async function del(d: TaxDeclaration) {
    if (!(await confirm({ title: "Delete this declaration?", destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`tax-declarations/${idOf(d.path)}`); toast({ title: "Declaration deleted", variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't delete the declaration", description: (e as Error).message, variant: "destructive" }); }
  }
  function pickProof(d: TaxDeclaration) { uploadFor.current = d; fileInput.current?.click(); }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; const d = uploadFor.current;
    e.target.value = "";
    if (!f || !d) return;
    try { await upload(`tax-declarations/${idOf(d.path)}`, f); toast({ title: "Proof uploaded", variant: "success" }); reload(); }
    catch (err) { toast({ title: "Upload failed", description: (err as Error).message, variant: "destructive" }); }
  }

  useIntent("new-tax", () => setDialog("new"));

  const newBtn = (
    <AccessAction collection="tax-declarations" create label="Add a declaration">
      <Button onClick={() => setDialog("new")}><Plus className="h-4 w-4" /> Add declaration</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Tax Declarations" description="Declare your tax-saving investments for the year and attach proofs." actions={newBtn} />
      {/* Declared and verified totals are summed over the loaded rows, which are one page of the collection. */}
      <TruncationNotice collection="tax-declarations" what="declarations" className="mb-3" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={fy} onValueChange={setFy}>
          <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{FY_OPTIONS.map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <input ref={fileInput} type="file" className="hidden" onChange={onFile} />

      <DataState state={state} error={error} onRetry={reload}>
        {inYear.length === 0 ? (
          <EmptyState icon={FileCheck} title="No declarations" description={`Add your tax-saving investments for FY ${fy}.`} action={newBtn} />
        ) : (
          <>
          <SummaryStrip
            items={[
              { label: "Declared", value: money(totalDeclared), hint: `FY ${fy}`, onClick: () => kf.setFocus(null), active: kf.focus === null },
              { label: "Verified", value: money(totalVerified), tone: totalVerified > 0 ? "success" : "muted", hint: totalVerified > 0 ? "locked in for tax" : "nothing verified yet", ...kf.kpi("verified") },
              { label: "Awaiting verification", value: awaiting, tone: awaiting ? "warning" : "muted", hint: awaiting ? "not counted yet" : "all checked", ...kf.kpi("awaiting") },
              ...(noProof ? [{ label: "No proof attached", value: noProof, tone: "warning" as const, hint: "attach proof first", ...kf.kpi("noProof") }] : []),
              { label: "Rejected", value: rejected, tone: rejected ? "destructive" : "muted", hint: rejected ? "edit to resubmit" : "none rejected", ...kf.kpi("rejected") },
            ]}
          />
          {items.length === 0 && (
            <p className="mb-4 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No {kf.activeLabel} in FY {fy}.{" "}
              <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show all declarations</button>
            </p>
          )}
          <div className="scroll-shadow-x overflow-x-auto rounded-lg border">
            {/* Seven columns of money and state: below `sm` each declaration is a labelled block under its
                section heading, which is the same information without the sideways scroll. */}
            <table className="table-stack w-full text-sm">
              <thead><tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Item</th>
                {showOwner && <th className="px-3 py-2 font-medium">Employee</th>}
                <th className="px-3 py-2 font-medium">Declared</th>
                <th className="px-3 py-2 font-medium">Verified</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Proof</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {groups.map(([section, ds]) => (
                  <Fragment key={section}>
                    {/* Section divider: the group's name and its declared subtotal. */}
                    <tr className="border-b bg-muted/30">
                      <td colSpan={showOwner ? 7 : 6} className="px-3 py-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-semibold">{section}{ds.length > 1 ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">{ds.length} items</span> : null}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">{money(ds.reduce((s, d) => s + d.declared_amount, 0))}</span>
                        </div>
                      </td>
                    </tr>
                    {ds.map((d) => {
                      const can = d.access?.can ?? [];
                      return (
                        <tr key={d.path} className="border-b last:border-0">
                          <td className="px-3 py-2">{d.label ? d.label : <span className="text-muted-foreground">{d.section}</span>}</td>
                          {showOwner && <td data-label="Employee" className="px-3 py-2 text-muted-foreground">{empName(d.employee)}</td>}
                          <td data-label="Declared" className="px-3 py-2 tabular-nums">{money(d.declared_amount)}</td>
                          <td data-label="Verified" className="px-3 py-2 tabular-nums">{d.status === "VERIFIED" ? money(d.verified_amount ?? 0) : "-"}</td>
                          <td data-label="Status" className="px-3 py-2">
                            <span title={d.status === "VERIFIED" ? "Verified declarations are locked." : d.status === "REJECTED" ? "Edit to fix and resubmit for verification." : undefined}>
                              <Badge variant={STATUS[d.status].variant}>{STATUS[d.status].label}</Badge>
                            </span>
                          </td>
                          <td data-label="Proof" className="px-3 py-2">
                            <div className="flex flex-wrap items-center justify-end gap-1 sm:justify-start">
                              {d.has_proof && <AccessAction verb="download" objectPath={d.path} can={can} label="View proof"><Button variant="ghost" size="sm" className="h-7" onClick={() => download(`tax-declarations/${idOf(d.path)}`, `proof-${d.section}`)}><Download className="h-3.5 w-3.5" /> View</Button></AccessAction>}
                              {/* A declaration waiting on verification with no proof attached is stuck - make the missing attachment visible. */}
                              {can.includes("upload") && d.status !== "VERIFIED" && <AccessAction verb="upload" objectPath={d.path} can={can} label="Attach proof"><Button variant="ghost" size="sm" className={`h-7 ${!d.has_proof && d.status === "DECLARED" ? "text-warning hover:text-warning dark:text-warning" : "text-muted-foreground"}`} onClick={() => pickProof(d)}><Paperclip className="h-3.5 w-3.5" /> {d.has_proof ? "Replace" : "Attach proof"}</Button></AccessAction>}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center justify-end gap-1">
                              {can.includes("verify") && d.status !== "VERIFIED" && <AccessAction verb="verify" objectPath={d.path} can={can} label="Verify declaration"><Button size="sm" variant="outline" className="h-7" onClick={() => setVerifying(d)}><Check className="h-3.5 w-3.5" /> Verify</Button></AccessAction>}
                              {can.includes("reject") && d.status === "DECLARED" && <AccessAction verb="reject" objectPath={d.path} can={can} label="Reject declaration"><Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => reject(d)} aria-label="Reject"><X className="h-3.5 w-3.5" /></Button></AccessAction>}
                              {can.includes("update") && d.status !== "VERIFIED" && mine(d) && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setDialog(d)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
                              {can.includes("delete") && d.status !== "VERIFIED" && mine(d) && <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => del(d)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </DataState>

      {dialog && (
        <DeclDialog
          declaration={dialog === "new" ? null : dialog}
          fy={fy}
          // THE YEAR'S ROWS, not the current view. `items` is the KPI-FOCUSED list, so pressing any tile in
          // the summary strip ("Rejected", say) narrowed the set this headroom is subtracted from while the
          // "Add declaration" button stayed available - and with 1,20,000 already under 80C, focusing a single
          // 10,000 rejected row made the dialog say 1,40,000 was left when 30,000 was. `overCap` went quiet
          // for the same reason, so the "past the cap won't reduce your tax" warning did not fire either. The
          // focus lives in the URL (`?focus=`), so the wrong figure was reachable from a bookmark, not just a
          // stray click. This note exists to prevent exactly the error it was causing.
          sameSectionTotal={(section) =>
            inYear
              .filter((d) => mine(d) && d.section === section && (dialog === "new" || d.path !== dialog.path))
              .reduce((s, d) => s + (d.status === "VERIFIED" ? d.verified_amount ?? d.declared_amount : d.declared_amount), 0)
          }
          onClose={() => setDialog(null)}
          onSave={save}
        />
      )}
      {verifying && (
        <VerifyDialog declaration={verifying} onClose={() => setVerifying(null)} onVerify={async (amount) => { await act(verifying, "verify", { verified_amount: amount }, true); setVerifying(null); }} />
      )}
    </div>
  );
}

// Statutory ceilings for the sections that have one. A declaration over the cap is not rejected - the excess
// simply never reduces tax - so the form says how much of the cap is already spoken for rather than blocking.
const SECTION_CAPS: Record<string, number> = { "80C": 150000, "80CCD(1B)": 50000, "80D": 25000, "80TTA": 10000 };

function DeclDialog({ declaration, fy, sameSectionTotal, onClose, onSave }: {
  declaration: TaxDeclaration | null;
  fy: string;
  // What this employee has already declared under the chosen section this year, excluding the row being edited.
  sameSectionTotal: (section: string) => number;
  onClose: () => void;
  onSave: (body: Record<string, unknown>, existing: TaxDeclaration | null) => Promise<void>;
}) {
  const [section, setSection] = useState(declaration?.section && SECTIONS.includes(declaration.section) ? declaration.section : declaration ? "Other" : "80C");
  const [customSection, setCustomSection] = useState(declaration && !SECTIONS.includes(declaration.section) ? declaration.section : "");
  const [label, setLabel] = useState(declaration?.label ?? "");
  const [amount, setAmount] = useState(declaration ? String(declaration.declared_amount) : "");
  const [note, setNote] = useState(declaration?.note ?? "");
  const sec = section === "Other" ? customSection.trim() : section;
  const valid = !!sec && Number(amount) > 0;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const resubmitting = declaration?.status === "REJECTED";
  const money = useMoney();
  const guard = useDialogGuard(true, { section, customSection, label, amount, note }, onClose, { label: "declaration" });
  const cap = SECTION_CAPS[sec];
  const already = sameSectionTotal(sec);
  const headroom = cap == null ? null : Math.max(0, cap - already);
  const overCap = cap != null && already + (Number(amount) || 0) > cap;

  async function doSave() {
    setBusy(true);
    setErr(null);
    try { await onSave({ section: sec, label: label.trim() || null, declared_amount: Number(amount), note: note.trim() || null }, declaration); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={guard.onOpenChange}>
      <DialogContent scrollBody onEnterSubmit={() => { if (valid && !busy) void doSave(); }}>
        <AccessScope collection="tax-declarations" objectPath={declaration?.path}>
        <DialogHeader>
          <DialogTitle>{resubmitting ? "Edit & resubmit declaration" : declaration ? "Edit declaration" : `Declare for FY ${fy}`}</DialogTitle>
          <DialogDescription>
            Payroll verifies each declaration against proof. Only the verified amount reduces the tax withheld from your salary - a declaration on its own changes nothing.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
        <FormError error={err} />
        {resubmitting && (
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
            This declaration was rejected. Saving your changes resubmits it to payroll for verification.
          </p>
        )}
        <FieldRow>
          <Field label="Section">
            <Select value={section} onValueChange={setSection}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{SECTIONS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Amount" error={amount !== "" && Number(amount) <= 0 ? "Enter an amount greater than 0." : undefined}>
            <MoneyInput value={amount} onChange={setAmount} min={0} autoFocus />
          </Field>
        </FieldRow>
        {section === "Other" && <Field label="Section name"><Input value={customSection} onChange={(e) => setCustomSection(e.target.value)} placeholder="e.g. 80GG" /></Field>}
        {/* The cap is the thing people get wrong: they declare the full premium under a section already filled
            by PF and EPS, and wonder why their tax didn't move. */}
        {cap != null && (
          <p className={cn("rounded-md border px-3 py-2 text-xs", overCap ? "border-warning/40 bg-warning/10" : "bg-muted/40 text-muted-foreground")}>
            {sec} caps at {money(cap)} a year.{" "}
            {already > 0 ? `You've already declared ${money(already)} under it, so ${money(headroom!)} is left.` : `Nothing declared under it yet.`}
            {overCap ? " Anything past the cap won't reduce your tax." : ""}
          </p>
        )}
        <Field label="What is it? (optional)"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. ELSS, PPF, life insurance premium" /></Field>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {declaration && <ActivitySection resource={declaration.path} className="border-t pt-3" />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => guard.onOpenChange(false)}>Cancel</Button>
          <Button onClick={doSave} loading={busy} disabled={!valid}>{resubmitting ? "Resubmit" : declaration ? "Save" : "Declare"}</Button>
        </DialogFooter>
        </AccessScope>
      </DialogContent>
    </Dialog>
  );
}

function VerifyDialog({ declaration, onClose, onVerify }: { declaration: TaxDeclaration; onClose: () => void; onVerify: (amount: number) => Promise<void> }) {
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [amount, setAmount] = useState(String(declaration.verified_amount ?? declaration.declared_amount));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = Number(amount);
  const valid = amount !== "" && n >= 0;
  const full = n === declaration.declared_amount;
  async function doVerify() {
    setBusy(true);
    setErr(null);
    try { await onVerify(n); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (valid && !busy) void doVerify(); }}>
        <DialogHeader>
          <DialogTitle>Verify declaration</DialogTitle>
          <DialogDescription>The verified amount is what reduces this employee's withholding from the next payroll run. Verifying locks the declaration.</DialogDescription>
        </DialogHeader>
        <FormError error={err} />
        <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">Claim</span><span className="font-medium">{declaration.section}{declaration.label ? ` · ${declaration.label}` : ""}</span></div>
          <div className="flex justify-between gap-3"><span className="text-muted-foreground">Declared</span><span className="font-medium tabular-nums">{money(declaration.declared_amount)}</span></div>
          {declaration.note && <div className="flex justify-between gap-3"><span className="text-muted-foreground">Note</span><span className="text-right">{declaration.note}</span></div>}
          {/* Verifying means checking the figure against the proof, so the proof has to be reachable from HERE -
              sending someone back to the row to open it, then back into this dialog, is how blind approvals happen. */}
          <div className="flex items-center justify-between gap-3 border-t pt-1">
            <span className="text-muted-foreground">Proof</span>
            {declaration.has_proof ? (
              <AccessAction collection="tax-declarations" objectPath={declaration.path} can={declaration.access?.can} verb="download" label="View proof">
                <Button variant="ghost" size="sm" className="h-7" onClick={() => download(`tax-declarations/${idOf(declaration.path)}`, `proof-${declaration.section}`)}>
                  <Download className="h-3.5 w-3.5" /> View attachment
                </Button>
              </AccessAction>
            ) : (
              <span className="font-medium text-warning-foreground dark:text-warning">Nothing attached</span>
            )}
          </div>
        </div>
        {!declaration.has_proof && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
            No proof is attached. Verifying without it puts the deduction into their withholding on your word alone.
          </p>
        )}
        <Field
          label="Verified amount"
          error={amount !== "" && n < 0 ? "Enter 0 or more." : undefined}
          hint={valid && n < declaration.declared_amount ? `${money(declaration.declared_amount - n)} less than declared - only the verified amount counts.` : valid && n > declaration.declared_amount ? "More than they declared." : undefined}
        >
          <MoneyInput value={amount} onChange={setAmount} min={0} autoFocus />
        </Field>
        {/* Proof usually matches the claim exactly, so accepting it in full should not mean retyping the figure. */}
        {!full && (
          <button type="button" className="self-start text-xs font-medium text-primary hover:underline" onClick={() => setAmount(String(declaration.declared_amount))}>
            Accept the full {money(declaration.declared_amount)}
          </button>
        )}
        <ActivitySection resource={declaration.path} className="border-t pt-3" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={doVerify} loading={busy} disabled={!valid}>Verify</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
