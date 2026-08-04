import { Fragment, useMemo, useRef, useState } from "react";
import { FileCheck, Plus, Pencil, Trash2, Check, X, Paperclip, Download } from "lucide-react";
import { create, patch, remove, invoke, upload, download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { formatMoney, idOf } from "@/lib/utils";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Employee, Me, TaxDeclaration, TaxDeclarationStatus } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const SECTIONS = ["80C", "80CCD(1B)", "80D", "80E", "80G", "80TTA", "HRA", "Home loan interest", "Other"];
const STATUS: Record<TaxDeclarationStatus, { label: string; variant: "secondary" | "success" | "destructive" }> = {
  DECLARED: { label: "Declared", variant: "secondary" },
  VERIFIED: { label: "Verified", variant: "success" },
  REJECTED: { label: "Rejected", variant: "destructive" },
};
// Indian financial year (Apr-Mar) of `d`, formatted "YYYY-YY".
function currentFy(d = new Date()) {
  const y = d.getFullYear();
  const start = d.getMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}
const FY_OPTIONS = (() => { const c = currentFy(); const s = Number(c.slice(0, 4)); return [c, `${s - 1}-${String(s % 100).padStart(2, "0")}`]; })();

export default function TaxDeclarations({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<TaxDeclaration>("tax-declarations");
  const { rows: employees } = useCollection<Employee>("employees");
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
  const items = useMemo(() => rows.filter((d) => d.financial_year === fy).sort((a, b) => a.section.localeCompare(b.section)), [rows, fy]);
  const totalDeclared = items.reduce((s, d) => s + d.declared_amount, 0);
  const totalVerified = items.reduce((s, d) => s + (d.status === "VERIFIED" ? (d.verified_amount ?? 0) : 0), 0);
  const awaiting = items.filter((d) => d.status === "DECLARED").length;
  const rejected = items.filter((d) => d.status === "REJECTED").length;
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

  async function save(body: Record<string, unknown>, existing: TaxDeclaration | null) {
    try {
      if (existing) await patch(`tax-declarations/${idOf(existing.path)}`, body, existing.etag);
      else await create("tax-declarations", { ...body, financial_year: fy });
      toast({ title: existing ? "Updated" : "Declared", variant: "success" });
      setDialog(null); reload();
    } catch (e) { toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" }); }
  }
  async function act(d: TaxDeclaration, verb: "verify" | "reject", body?: Record<string, unknown>) {
    try {
      await invoke(`tax-declarations/${idOf(d.path)}`, verb, undefined, body);
      toast({ title: verb === "verify" ? "Declaration verified" : "Declaration rejected", variant: "success" });
      reload();
    } catch (e) { toast({ title: verb === "verify" ? "Couldn't verify the declaration" : "Couldn't reject the declaration", description: (e as Error).message, variant: "destructive" }); }
  }
  async function reject(d: TaxDeclaration) {
    if (!(await confirm({ title: `Reject the ${d.section} declaration?`, description: "The employee can edit it to fix the problem - saving resubmits it for verification.", destructive: true, confirmLabel: "Reject" }))) return;
    act(d, "reject");
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

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={fy} onValueChange={setFy}>
          <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
          <SelectContent>{FY_OPTIONS.map((y) => <SelectItem key={y} value={y}>FY {y}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <input ref={fileInput} type="file" className="hidden" onChange={onFile} />

      <DataState state={state} error={error} onRetry={reload}>
        {items.length === 0 ? (
          <EmptyState icon={FileCheck} title="No declarations" description={`Add your tax-saving investments for FY ${fy}.`} action={newBtn} />
        ) : (
          <>
          <SummaryStrip
            items={[
              { label: "Declared", value: money(totalDeclared), hint: `FY ${fy}` },
              { label: "Verified", value: money(totalVerified), tone: totalVerified > 0 ? "success" : "muted", hint: totalVerified > 0 ? "locked in for tax computation" : "nothing verified yet" },
              { label: "Awaiting verification", value: awaiting, tone: awaiting ? "warning" : "muted" },
              { label: "Rejected", value: rejected, tone: rejected ? "destructive" : "muted", hint: rejected ? "edit to resubmit" : undefined },
            ]}
          />
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
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
                          {showOwner && <td className="px-3 py-2 text-muted-foreground">{empName(d.employee)}</td>}
                          <td className="px-3 py-2 tabular-nums">{money(d.declared_amount)}</td>
                          <td className="px-3 py-2 tabular-nums">{d.status === "VERIFIED" ? money(d.verified_amount ?? 0) : "-"}</td>
                          <td className="px-3 py-2">
                            <span title={d.status === "VERIFIED" ? "Verified declarations are locked." : d.status === "REJECTED" ? "Edit to fix and resubmit for verification." : undefined}>
                              <Badge variant={STATUS[d.status].variant}>{STATUS[d.status].label}</Badge>
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1">
                              {d.has_proof && <AccessAction verb="download" objectPath={d.path} can={can} label="View proof"><Button variant="ghost" size="sm" className="h-7" onClick={() => download(`tax-declarations/${idOf(d.path)}`, `proof-${d.section}`)}><Download className="h-3.5 w-3.5" /> View</Button></AccessAction>}
                              {/* A declaration waiting on verification with no proof attached is stuck - make the missing attachment visible. */}
                              {can.includes("upload") && d.status !== "VERIFIED" && <AccessAction verb="upload" objectPath={d.path} can={can} label="Attach proof"><Button variant="ghost" size="sm" className={`h-7 ${!d.has_proof && d.status === "DECLARED" ? "text-warning hover:text-warning dark:text-warning" : "text-muted-foreground"}`} onClick={() => pickProof(d)}><Paperclip className="h-3.5 w-3.5" /> {d.has_proof ? "Replace" : "Attach proof"}</Button></AccessAction>}
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center justify-end gap-1">
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

      {dialog && <DeclDialog declaration={dialog === "new" ? null : dialog} fy={fy} onClose={() => setDialog(null)} onSave={save} />}
      {verifying && (
        <VerifyDialog declaration={verifying} onClose={() => setVerifying(null)} onVerify={async (amount) => { await act(verifying, "verify", { verified_amount: amount }); setVerifying(null); }} />
      )}
    </div>
  );
}

function DeclDialog({ declaration, fy, onClose, onSave }: {
  declaration: TaxDeclaration | null;
  fy: string;
  onClose: () => void;
  onSave: (body: Record<string, unknown>, existing: TaxDeclaration | null) => void;
}) {
  const [section, setSection] = useState(declaration?.section && SECTIONS.includes(declaration.section) ? declaration.section : declaration ? "Other" : "80C");
  const [customSection, setCustomSection] = useState(declaration && !SECTIONS.includes(declaration.section) ? declaration.section : "");
  const [label, setLabel] = useState(declaration?.label ?? "");
  const [amount, setAmount] = useState(declaration ? String(declaration.declared_amount) : "");
  const [note, setNote] = useState(declaration?.note ?? "");
  const sec = section === "Other" ? customSection.trim() : section;
  const valid = !!sec && Number(amount) > 0;
  const [busy, setBusy] = useState(false);
  const resubmitting = declaration?.status === "REJECTED";
  async function doSave() {
    setBusy(true);
    try { await onSave({ section: sec, label: label.trim() || null, declared_amount: Number(amount), note: note.trim() || null }, declaration); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (valid && !busy) doSave(); }}>
        <DialogHeader><DialogTitle>{resubmitting ? "Edit & resubmit declaration" : declaration ? "Edit declaration" : `Declare for FY ${fy}`}</DialogTitle></DialogHeader>
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
            <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
          </Field>
        </FieldRow>
        {section === "Other" && <Field label="Section name"><Input value={customSection} onChange={(e) => setCustomSection(e.target.value)} placeholder="e.g. 80GG" /></Field>}
        <Field label="What is it? (optional)"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. ELSS, PPF, life insurance premium" /></Field>
        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        {declaration && <ActivitySection resource={declaration.path} className="border-t pt-3" />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={doSave} loading={busy} disabled={!valid}>{resubmitting ? "Resubmit" : declaration ? "Save" : "Declare"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VerifyDialog({ declaration, onClose, onVerify }: { declaration: TaxDeclaration; onClose: () => void; onVerify: (amount: number) => Promise<void> }) {
  const { org } = useOrg();
  const money = (n: number) => formatMoney(n, org.default_currency, currencyDecimals(undefined, org));
  const [amount, setAmount] = useState(String(declaration.verified_amount ?? declaration.declared_amount));
  const [busy, setBusy] = useState(false);
  const n = Number(amount);
  const valid = amount !== "" && n >= 0;
  async function doVerify() {
    setBusy(true);
    try { await onVerify(n); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent onEnterSubmit={() => { if (valid && !busy) doVerify(); }}>
        <DialogHeader><DialogTitle>Verify declaration</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">{declaration.section}{declaration.label ? ` · ${declaration.label}` : ""} · declared <span className="font-medium tabular-nums text-foreground">{money(declaration.declared_amount)}</span>. Once verified, the declaration is locked.</p>
        <Field label="Verified amount" error={amount !== "" && n < 0 ? "Enter 0 or more." : undefined} hint={valid && n < declaration.declared_amount ? "Less than declared - only the verified amount counts." : undefined}>
          <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </Field>
        <ActivitySection resource={declaration.path} className="border-t pt-3" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={doVerify} loading={busy} disabled={!valid}>Verify</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
