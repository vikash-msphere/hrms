import { useMemo, useRef, useState } from "react";
import { UserPlus, Plus, Pencil, Trash2, Paperclip, Download, Gift, UserCheck } from "lucide-react";
import { create, patch, remove, invoke, upload, download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatMoney, idOf } from "@/lib/utils";
import { navigate } from "@/router";
import { useOrg, currencyDecimals } from "@/lib/org";
import type { Department, Employee, Me, Referral, Candidate } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const STATUSES = ["submitted", "screening", "interviewing", "hired", "joined", "rejected", "withdrawn"] as const;
type Variant = "secondary" | "success" | "destructive";
const STATUS_META: Record<string, { label: string; variant: Variant }> = {
  submitted: { label: "Submitted", variant: "secondary" },
  screening: { label: "Screening", variant: "secondary" },
  interviewing: { label: "Interviewing", variant: "secondary" },
  hired: { label: "Hired", variant: "success" },
  joined: { label: "Joined", variant: "success" },
  rejected: { label: "Rejected", variant: "destructive" },
  withdrawn: { label: "Withdrawn", variant: "destructive" },
};
const BONUS_META: Record<string, { label: string; variant: Variant }> = {
  pending: { label: "Bonus pending", variant: "secondary" },
  eligible: { label: "Bonus awarded", variant: "success" },
  paid: { label: "Bonus paid", variant: "success" },
  cancelled: { label: "Bonus cancelled", variant: "destructive" },
};
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");

// The bonus trail: pending → awarded (eligible) → paid, shown as a mini step trail under the badge.
const BONUS_PATH = ["pending", "eligible", "paid"] as const;

function BonusCell({ r, money }: { r: Referral; money: (n?: number) => string }) {
  const st = r.bonus_status ?? "pending";
  const closed = r.status === "rejected" || r.status === "withdrawn";
  if (st === "cancelled") return <Badge variant="destructive">Bonus cancelled</Badge>;
  if (closed && st === "pending") return <span className="text-xs text-muted-foreground">No bonus</span>;
  const idx = BONUS_PATH.indexOf(st as (typeof BONUS_PATH)[number]);
  const bm = BONUS_META[st] ?? BONUS_META.pending;
  const when = st === "paid" ? fmtDate(r.bonus_paid_time) : st === "eligible" ? fmtDate(r.bonus_eligible_time) : "";
  return (
    <div className="flex flex-col gap-1">
      <Badge variant={bm.variant} className="w-fit">{bm.label}</Badge>
      <div className="flex items-center gap-1" aria-hidden>
        {BONUS_PATH.map((step, i) => (
          <span
            key={step}
            title={BONUS_META[step].label}
            className={cn("h-1.5 rounded-full", i === idx ? "w-4 bg-primary" : "w-1.5", i < idx && "bg-primary/40", i > idx && "bg-muted-foreground/25")}
          />
        ))}
      </div>
      {(r.bonus_amount || when) && (
        <span className="text-xs tabular-nums text-muted-foreground">{[r.bonus_amount ? money(r.bonus_amount) : "", when].filter(Boolean).join(" · ")}</span>
      )}
    </div>
  );
}

export default function Referrals({ me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Referral>("referrals");
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  // Only loads for callers who can read candidates (HR/recruiters); others get an empty list, which is fine -
  // it's only used to stop "To pipeline" creating the same candidate twice.
  const { rows: candidates, reload: reloadCandidates } = useCollection<Candidate>("candidates");
  const inPipeline = useMemo(() => new Map(candidates.filter((c) => c.referral).map((c) => [idOf(c.referral!), idOf(c.path)])), [candidates]);
  const { toast } = useToast();
  const confirm = useConfirm();
  const { org } = useOrg();
  const money = (n?: number) => (n == null ? "" : formatMoney(n, org.default_currency, currencyDecimals(undefined, org)));
  const [dialog, setDialog] = useState<Referral | "new" | null>(null);
  useDeepOpen(openId, rows, setDialog);
  const [uploading, setUploading] = useState<string | null>(null);
  const uploadFor = useRef<Referral | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`.trim()]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "Employee" : "");
  }, [employees]);
  const deptName = useMemo(() => {
    const m = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
    return (ref?: string) => (ref ? m.get(idOf(ref)) ?? "" : "");
  }, [departments]);

  const mine = (r: Referral) => !!r.referrer && idOf(r.referrer) === me.employee_id;
  const items = useMemo(() => [...rows].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? "")), [rows]);
  const showOwner = items.some((r) => !mine(r));

  async function del(r: Referral) {
    if (!(await confirm({ title: "Withdraw this referral?", destructive: true, confirmLabel: "Withdraw" }))) return;
    try { await remove(`referrals/${idOf(r.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't withdraw", description: (e as Error).message, variant: "destructive" }); }
  }
  async function award(r: Referral) {
    if (!(await confirm({ title: "Award the referral bonus now?", description: "Creates a bonus paid on the referrer's next payroll run.", confirmLabel: "Award" }))) return;
    try { await invoke(`referrals/${idOf(r.path)}`, "award"); toast({ title: "Bonus awarded 🎉", variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't award", description: (e as Error).message, variant: "destructive" }); }
  }
  async function toPipeline(r: Referral) {
    if (!(await confirm({ title: "Add to the candidate pipeline?", description: "Creates a candidate (sourced from this referral) you can then apply to an open job.", confirmLabel: "Add" }))) return;
    try {
      await create<Candidate>("candidates", {
        name: r.candidate_name,
        email: r.candidate_email || null,
        phone: r.candidate_phone || null,
        source: "referral",
        referral: r.path,
      });
      toast({ title: "Added to pipeline", description: "Find them under Candidates.", variant: "success" });
      reloadCandidates();
    } catch (e) { toast({ title: "Couldn't add", description: (e as Error).message, variant: "destructive" }); }
  }
  function pickResume(r: Referral) { uploadFor.current = r; fileInput.current?.click(); }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; const r = uploadFor.current;
    e.target.value = "";
    if (!f || !r) return;
    setUploading(r.path);
    try { await upload(`referrals/${idOf(r.path)}`, f); toast({ title: "Resume uploaded", variant: "success" }); reload(); }
    catch (err) { toast({ title: "Couldn't upload the resume", description: (err as Error).message, variant: "destructive" }); }
    finally { setUploading(null); }
  }

  useIntent("new-referral", () => setDialog("new"));

  const newBtn = (
    <AccessAction collection="referrals" create label="Refer a candidate">
      <Button onClick={() => setDialog("new")}><Plus className="h-4 w-4" /> Refer someone</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Referrals" description="Refer people to open roles and track their progress." actions={<>{newBtn}<PageSettings me={me} host="referrals" /></>} />

      <input ref={fileInput} type="file" className="hidden" onChange={onFile} />

      <DataState state={state} error={error} onRetry={reload}>
        {items.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Referrals", value: items.length, icon: UserPlus },
              { label: "In progress", value: items.filter((r) => ["submitted", "screening", "interviewing"].includes(r.status)).length, tone: "primary" },
              { label: "Hired or joined", value: items.filter((r) => r.status === "hired" || r.status === "joined").length, icon: UserCheck, tone: "success" },
              {
                label: "Bonuses paid", value: items.filter((r) => r.bonus_status === "paid").length, icon: Gift,
                hint: (() => { const s = items.filter((r) => r.bonus_status === "paid").reduce((t, r) => t + (r.bonus_amount ?? 0), 0); return s ? money(s) : undefined; })(),
              },
            ]}
          />
        )}
        {items.length === 0 ? (
          <EmptyState icon={UserPlus} title="No referrals yet" description="Know someone great? Refer them and track their progress here." action={newBtn} />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Candidate</th>
                {showOwner && <th className="px-3 py-2 font-medium">Referrer</th>}
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Bonus</th>
                <th className="px-3 py-2 font-medium">Resume</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {items.map((r) => {
                  const can = r.access?.can ?? [];
                  const sm = STATUS_META[r.status] ?? { label: r.status, variant: "secondary" as Variant };
                  return (
                    <tr key={r.path} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.candidate_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {[r.position_title, deptName(r.department)].filter(Boolean).join(" · ")}
                          {r.candidate_email ? <div>{r.candidate_email}</div> : null}
                        </div>
                      </td>
                      {showOwner && <td className="px-3 py-2 text-muted-foreground">{empName(r.referrer)}</td>}
                      <td className="px-3 py-2"><Badge variant={sm.variant}>{sm.label}</Badge></td>
                      <td className="px-3 py-2">
                        <BonusCell r={r} money={money} />
                        {can.includes("award") && (r.bonus_status ?? "pending") === "pending" && !r.hired_employee && (r.status === "hired" || r.status === "joined") && (
                          <p className="mt-1 text-xs text-muted-foreground">Link the hired employee (edit) to enable the bonus.</p>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          {r.has_resume && <AccessAction verb="download" objectPath={r.path} can={can} label="Download referral resume"><Button variant="ghost" size="sm" className="h-7" onClick={() => download(`referrals/${idOf(r.path)}`, `resume-${r.candidate_name}`)}><Download className="h-3.5 w-3.5" /> View</Button></AccessAction>}
                          {can.includes("upload") && <AccessAction verb="upload" objectPath={r.path} can={can} label="Attach referral resume"><Button variant="ghost" size="sm" className="h-7 text-muted-foreground" loading={uploading === r.path} onClick={() => pickResume(r)}><Paperclip className="h-3.5 w-3.5" /> {r.has_resume ? "Replace" : "Attach"}</Button></AccessAction>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {can.includes("award") && (inPipeline.has(idOf(r.path))
                            ? <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" title="Open the candidate this referral became" onClick={() => navigate(`candidates/${inPipeline.get(idOf(r.path))}`)}><UserCheck className="h-3.5 w-3.5" /> In pipeline</Button>
                            : <Button size="sm" variant="ghost" className="h-7" onClick={() => toPipeline(r)}><UserCheck className="h-3.5 w-3.5" /> To pipeline</Button>)}
                          {can.includes("award") && (r.bonus_status ?? "pending") === "pending" && !!r.hired_employee && <AccessAction verb="award" objectPath={r.path} can={can} label="Award referral bonus"><Button size="sm" variant="outline" className="h-7" onClick={() => award(r)}><Gift className="h-3.5 w-3.5" /> Award now</Button></AccessAction>}
                          {can.includes("update") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setDialog(r)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
                          {can.includes("delete") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => del(r)} aria-label="Withdraw"><Trash2 className="h-3.5 w-3.5" /></Button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DataState>

      {dialog && (
        <ReferralDialog
          referral={dialog === "new" ? null : dialog}
          employees={employees}
          departments={departments}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload(); }}
        />
      )}
    </div>
  );
}

function ReferralDialog({ referral, employees, departments, onClose, onSaved }: {
  referral: Referral | null;
  employees: Employee[];
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const editing = !!referral;
  // Manage fields (status / hired employee / bonus amount) are HR-only. The `award` verb is granted to HR/payroll
  // (never to a referrer over their own row), so it cleanly distinguishes an HR editor from a self-editor.
  const canManage = (referral?.access?.can ?? []).includes("award");

  const [name, setName] = useState(referral?.candidate_name ?? "");
  const [email, setEmail] = useState(referral?.candidate_email ?? "");
  const [phone, setPhone] = useState(referral?.candidate_phone ?? "");
  const [position, setPosition] = useState(referral?.position_title ?? "");
  const [dept, setDept] = useState(referral?.department ? idOf(referral.department) : "");
  const [notes, setNotes] = useState(referral?.notes ?? "");
  const [status, setStatus] = useState(referral?.status ?? "submitted");
  const [hired, setHired] = useState(referral?.hired_employee ? idOf(referral.hired_employee) : "");
  const [bonusAmount, setBonusAmount] = useState(referral?.bonus_amount != null ? String(referral.bonus_amount) : "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const emailError = email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim()) ? "Doesn't look like an email address." : undefined;
  const valid = !!name.trim() && !emailError;

  async function save() {
    setBusy(true);
    try {
      const base = {
        candidate_name: name.trim(),
        candidate_email: email.trim() || null,
        candidate_phone: phone.trim() || null,
        position_title: position.trim() || null,
        department: dept ? `departments/${dept}` : null,
        notes: notes.trim() || null,
      };
      const manage = canManage ? {
        status,
        hired_employee: hired ? `employees/${hired}` : null,
        bonus_amount: bonusAmount.trim() ? Number(bonusAmount) : null,
      } : {};
      let path: string;
      if (editing) {
        await patch(`referrals/${idOf(referral!.path)}`, { ...base, ...manage }, referral!.etag);
        path = referral!.path;
      } else {
        const row = await create<Referral>("referrals", base);
        path = row.path;
      }
      if (file) await upload(`referrals/${idOf(path)}`, file);
      toast({ title: editing ? "Updated" : "Referral submitted 🎉", variant: "success" });
      onSaved();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto" onEnterSubmit={() => { if (valid && !busy) void save(); }}>
        <DialogHeader><DialogTitle>{editing ? "Edit referral" : "Refer a candidate"}</DialogTitle></DialogHeader>
        <FieldRow>
          <Field label="Candidate name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Position (optional)"><Input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="e.g. Senior Engineer" /></Field>
        </FieldRow>
        <FieldRow>
          <Field label="Email (optional)" error={emailError}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Phone (optional)"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
        </FieldRow>
        <Field label="Department (optional)">
          <Select value={dept || "none"} onValueChange={(v) => setDept(v === "none" ? "" : v)}>
            <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Any / unsure</SelectItem>
              {departments.map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Notes (optional)"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why they'd be a great fit…" /></Field>
        <Field label={referral?.has_resume ? "Replace resume (optional)" : "Resume (optional)"}>
          <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>

        {canManage && (
          <div className="mt-2 space-y-4 rounded-lg border bg-muted/20 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Hiring &amp; bonus (HR)</p>
            <FieldRow>
              <Field label="Status">
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Bonus amount (optional)"><Input type="number" min={0} value={bonusAmount} onChange={(e) => setBonusAmount(e.target.value)} placeholder="Default from settings" /></Field>
            </FieldRow>
            <Field label="Hired employee (milestone anchor)">
              <Combobox
                value={hired || "none"}
                onValueChange={(v) => setHired(v === "none" ? "" : v)}
                options={[{ value: "none", label: "Not hired yet" }, ...employees.map((e) => ({ value: idOf(e.path), label: `${e.first_name} ${e.last_name}`.trim() }))]}
                placeholder="Not hired yet"
                searchPlaceholder="Search people…"
                emptyText="No one matches."
              />
            </Field>
          </div>
        )}

        {referral && <ActivitySection resource={referral.path} className="border-t pt-3" />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!valid}>{editing ? "Save" : "Submit referral"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
