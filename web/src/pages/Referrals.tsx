import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Link2, UserPlus, Plus, Pencil, Trash2, Paperclip, Download, Gift, UserCheck } from "lucide-react";
import { create, get, patch, remove, invoke, upload, download } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, formatMoney, idOf } from "@/lib/utils";
import { isConflict } from "@/lib/formError";
import { navigate, recordUrl, setRouteRecord } from "@/router";
import { useOrg, currencyDecimals, useMoney } from "@/lib/org";
import type { Department, Employee, Me, Referral, Candidate, JobRequisition } from "@/types";
import { DEFAULT_REFERRALS_CONFIG, type ReferralsConfig } from "../../../src/domain/referrals";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { WriteDialog } from "@/components/common/WriteDialog";
import { FileDropField } from "@/components/common/FileDropField";
import { MoneyInput } from "@/components/common/MoneyInput";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";

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
  // it's only used to stop "To pipeline" creating the same candidate twice, and to mark the referrals that
  // already became one. Both need a referral on screen first, so an empty board reads nothing.
  const { rows: candidates, reload: reloadCandidates } = useCollection<Candidate>("candidates", { enabled: rows.length > 0 });
  const inPipeline = useMemo(() => new Map(candidates.filter((c) => c.referral).map((c) => [idOf(c.referral!), idOf(c.path)])), [candidates]);
  const { toast } = useToast();
  const confirm = useConfirm();
  const { org } = useOrg();
  const money = (n?: number) => (n == null ? "" : formatMoney(n, org.default_currency, currencyDecimals(undefined, org)));
  const [dialog, setDialog] = useState<Referral | "new" | null>(null);
  useDeepOpen(openId, rows, setDialog);
  // A referral HR is asking about is pasteable; `useDeepOpen` above reads the id back in.
  function openDialog(d: Referral | "new") { setDialog(d); setRouteRecord(d === "new" ? null : idOf(d.path)); }
  function closeDialog() { setDialog(null); setRouteRecord(null); }
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

  // The two things that stall on this page: a hire whose bonus nobody awarded, and a referral nobody moved
  // into the pipeline. Both are metrics you click, not a status column you scan.
  const bonusDue = (r: Referral) => (r.status === "hired" || r.status === "joined") && (r.bonus_status ?? "pending") === "pending";
  const notInPipeline = (r: Referral) => r.status === "submitted" && !inPipeline.has(idOf(r.path));
  const kf = useKpiFocus<Referral, "all" | "progress" | "hired" | "paid" | "bonusDue" | "notInPipeline" | "mine">({
    all: { label: "referrals", match: () => true },
    progress: { label: "referrals in progress", match: (r) => ["submitted", "screening", "interviewing"].includes(r.status) },
    hired: { label: "hired referrals", match: (r) => r.status === "hired" || r.status === "joined" },
    paid: { label: "paid bonuses", match: (r) => r.bonus_status === "paid" },
    bonusDue: { label: "bonuses still owed", match: bonusDue },
    notInPipeline: { label: "referrals not in the pipeline", match: notInPipeline },
    mine: { label: "referrals of your own", match: mine },
  });
  const shown = useMemo(() => kf.apply(items), [items, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

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
        email: r.candidate_email ?? "",
        phone: r.candidate_phone ?? "",
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

  useIntent("new-referral", () => openDialog("new"));

  const newBtn = (
    <AccessAction collection="referrals" create label="Refer a candidate">
      <Button onClick={() => openDialog("new")}><Plus className="h-4 w-4" /> Refer someone</Button>
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
              { label: "Referrals", value: items.length, icon: UserPlus, hint: "every referral", onClick: () => kf.setFocus(null), active: kf.focus === null },
              ...(showOwner && items.some(mine)
                ? [{ label: "Yours", value: items.filter(mine).length, icon: UserPlus, tone: "primary" as const, hint: "you referred these", ...kf.kpi("mine") }]
                : []),
              { label: "In progress", value: items.filter((r) => ["submitted", "screening", "interviewing"].includes(r.status)).length, tone: "primary", hint: "in the funnel", ...kf.kpi("progress") },
              ...(items.some(notInPipeline)
                ? [{ label: "Not in pipeline", value: items.filter(notInPipeline).length, tone: "warning" as const, hint: "nobody screened these", ...kf.kpi("notInPipeline") }]
                : []),
              { label: "Hired or joined", value: items.filter((r) => r.status === "hired" || r.status === "joined").length, icon: UserCheck, tone: "success", hint: "referrals that stuck", ...kf.kpi("hired") },
              ...(items.some(bonusDue)
                ? [{
                    label: "Bonus owed", value: items.filter(bonusDue).length, icon: Gift, tone: "warning" as const,
                    hint: (() => { const s = items.filter(bonusDue).reduce((t, r) => t + (r.bonus_amount ?? 0), 0); return s ? money(s) : "award it on the row"; })(),
                    ...kf.kpi("bonusDue"),
                  }]
                : []),
              {
                label: "Bonuses paid", value: items.filter((r) => r.bonus_status === "paid").length, icon: Gift,
                hint: (() => { const s = items.filter((r) => r.bonus_status === "paid").reduce((t, r) => t + (r.bonus_amount ?? 0), 0); return s ? money(s) : "nothing paid yet"; })(),
                ...kf.kpi("paid"),
              },
            ]}
          />
        )}
        {items.length === 0 ? (
          <EmptyState icon={UserPlus} title="No referrals yet" description="Know someone great? Refer them and track their progress here." action={newBtn} />
        ) : (
          <div className="scroll-shadow-x overflow-x-auto rounded-lg border">
            {/* Six columns, two of them action clusters: below `sm` each referral reads as a labelled block
                instead of a table nobody can scroll to the end of. */}
            <table className="table-stack w-full text-sm">
              <thead><tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Candidate</th>
                {showOwner && <th className="px-3 py-2 font-medium">Referrer</th>}
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Bonus</th>
                <th className="px-3 py-2 font-medium">Resume</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={showOwner ? 6 : 5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No {kf.activeLabel ?? "referrals"}.{" "}
                    <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show all referrals</button>
                  </td></tr>
                )}
                {shown.map((r) => {
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
                      {showOwner && <td data-label="Referrer" className="px-3 py-2 text-muted-foreground">{empName(r.referrer)}</td>}
                      <td data-label="Status" className="px-3 py-2"><Badge variant={sm.variant}>{sm.label}</Badge></td>
                      {/* Wrapped, so the amount and the note that explains it stay one value when the row
                          stacks into a label/value pair on a phone. */}
                      <td data-label="Bonus" className="px-3 py-2">
                        <span className="inline-block text-right sm:text-left">
                          <BonusCell r={r} money={money} />
                          {can.includes("award") && (r.bonus_status ?? "pending") === "pending" && !r.hired_employee && (r.status === "hired" || r.status === "joined") && (
                            <span className="mt-1 block text-xs text-muted-foreground">Link the hired employee (edit) to enable the bonus.</span>
                          )}
                        </span>
                      </td>
                      <td data-label="Resume" className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1 sm:justify-start">
                          {r.has_resume && <AccessAction verb="download" objectPath={r.path} can={can} label="Download referral resume"><Button variant="ghost" size="sm" className="h-7" onClick={() => download(`referrals/${idOf(r.path)}`, `resume-${r.candidate_name}`)}><Download className="h-3.5 w-3.5" /> View</Button></AccessAction>}
                          {can.includes("upload") && <AccessAction verb="upload" objectPath={r.path} can={can} label="Attach referral resume"><Button variant="ghost" size="sm" className="h-7 text-muted-foreground" loading={uploading === r.path} onClick={() => pickResume(r)}><Paperclip className="h-3.5 w-3.5" /> {r.has_resume ? "Replace" : "Attach"}</Button></AccessAction>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {can.includes("award") && (inPipeline.has(idOf(r.path))
                            ? <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" title="Open the candidate this referral became" onClick={() => navigate(`candidates/${inPipeline.get(idOf(r.path))}`)}><UserCheck className="h-3.5 w-3.5" /> In pipeline</Button>
                            : <Button size="sm" variant="ghost" className="h-7" onClick={() => toPipeline(r)}><UserCheck className="h-3.5 w-3.5" /> To pipeline</Button>)}
                          {can.includes("award") && (r.bonus_status ?? "pending") === "pending" && !!r.hired_employee && <AccessAction verb="award" objectPath={r.path} can={can} label="Award referral bonus"><Button size="sm" variant="outline" className="h-7" onClick={() => award(r)}><Gift className="h-3.5 w-3.5" /> Award now</Button></AccessAction>}
                          {can.includes("update") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openDialog(r)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
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
          referrals={rows}
          candidates={candidates}
          employees={employees}
          departments={departments}
          empName={empName}
          onClose={closeDialog}
          onSaved={() => { closeDialog(); reload(); }}
        />
      )}
    </div>
  );
}

// What each status means for the bonus, said beside the picker: the trail on the row shows where the money is,
// this says what moves it.
const STATUS_EFFECT: Record<string, string> = {
  submitted: "Waiting for someone to screen them.",
  screening: "Being screened - no bonus in sight yet.",
  interviewing: "In interviews.",
  hired: "Hired. Link the employee below and the bonus becomes awardable.",
  joined: "Joined. This is what the milestone job watches.",
  rejected: "Closed. No bonus is owed.",
  withdrawn: "Closed. No bonus is owed.",
};

const EMPTY_REFERRAL = { name: "", email: "", phone: "", position: "", dept: "", notes: "", status: "submitted", hired: "", bonusAmount: "" };

function ReferralDialog({ referral, referrals, candidates, employees, departments, empName, onClose, onSaved }: {
  referral: Referral | null;
  /** Every referral in view, for the "already referred" guard. */
  referrals: Referral[];
  candidates: Candidate[];
  employees: Employee[];
  departments: Department[];
  empName: (ref?: string) => string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const money = useMoney();
  const editing = !!referral;
  // Manage fields (status / hired employee / bonus amount) are HR-only. The `award` verb is granted to HR/payroll
  // (never to a referrer over their own row), so it cleanly distinguishes an HR editor from a self-editor.
  const canManage = (referral?.access?.can ?? []).includes("award");

  const [form, setForm] = useState(() => (referral
    ? {
        name: referral.candidate_name ?? "",
        email: referral.candidate_email ?? "",
        phone: referral.candidate_phone ?? "",
        position: referral.position_title ?? "",
        dept: referral.department ? idOf(referral.department) : "",
        notes: referral.notes ?? "",
        status: referral.status ?? "submitted",
        hired: referral.hired_employee ? idOf(referral.hired_employee) : "",
        bonusAmount: referral.bonus_amount != null ? String(referral.bonus_amount) : "",
      }
    : EMPTY_REFERRAL));
  const [file, setFile] = useState<File | null>(null);
  // The version an edit writes against, refreshed from the server when a save loses a race.
  const [etag, setEtag] = useState(referral?.etag);

  // Both fetched with the dialog rather than the page: a referrer opens this once, and the page itself has no
  // use for either. An employee who can't read requisitions simply gets no role chips.
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions");
  const [cfg, setCfg] = useState<ReferralsConfig>(DEFAULT_REFERRALS_CONFIG);
  useEffect(() => {
    getSetting<Partial<ReferralsConfig>>("referrals")
      .then((s) => { if (s.value) setCfg({ ...DEFAULT_REFERRALS_CONFIG, ...s.value }); })
      .catch(() => { /* no config, or not readable: the default is the policy */ });
  }, []);

  const emailError = form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim()) ? "Doesn't look like an email address." : undefined;
  const canSubmit = !!form.name.trim() && !emailError;

  // The same friend referred twice pays nobody twice, and the second row just muddies the count. Email first,
  // then name; the pool is checked too, since a name already in screening is not a new referral.
  const twin = useMemo(() => {
    const email = form.email.trim().toLowerCase();
    const name = form.name.trim().toLowerCase();
    const others = referrals.filter((r) => r.path !== referral?.path);
    return (
      (email ? others.find((r) => (r.candidate_email ?? "").trim().toLowerCase() === email) : undefined)
      ?? (name ? others.find((r) => (r.candidate_name ?? "").trim().toLowerCase() === name) : undefined)
      ?? null
    );
  }, [referrals, form.email, form.name, referral?.path]);
  const inPool = useMemo(() => {
    const email = form.email.trim().toLowerCase();
    if (!email) return null;
    return candidates.find((c) => (c.email ?? "").trim().toLowerCase() === email) ?? null;
  }, [candidates, form.email]);

  // What the referrer stands to earn, and when - the whole reason anybody fills this form in.
  const bonusPreview = useMemo(() => {
    const explicit = form.bonusAmount.trim() ? Number(form.bonusAmount) : null;
    const when = cfg.award_trigger === "joining" ? "once they join" : "once they pass probation";
    if (explicit != null && Number.isFinite(explicit)) return `${money(explicit)} ${when}.`;
    const tiers = cfg.join_tiers ?? [];
    if (tiers.length) {
      const parts = tiers.map((t) => (t.max_days == null ? `${money(t.amount)} after that` : `${money(t.amount)} if they join within ${t.max_days} days`));
      return `${parts.join(", ")} - paid ${when}.`;
    }
    return `${money(cfg.default_bonus_amount)} ${when}.`;
  }, [cfg, form.bonusAmount, money]);

  // Roles actually open, so a referral lands against something real instead of a typed job title.
  const openRoles = useMemo(() => reqs.filter((r) => r.status === "open").slice(0, 6), [reqs]);

  function copyLink() {
    navigator.clipboard.writeText(recordUrl("referrals", idOf(referral!.path))).then(
      () => toast({ title: "Link copied", description: "Anyone who can see this referral can open it." }),
      () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
    );
  }

  async function submit() {
    const base = {
      candidate_name: form.name.trim(),
      candidate_email: form.email.trim(),
      candidate_phone: form.phone.trim(),
      position_title: form.position.trim(),
      department: form.dept ? `departments/${form.dept}` : "",
      notes: form.notes.trim(),
    };
    const manage = canManage ? {
      status: form.status,
      hired_employee: form.hired ? `employees/${form.hired}` : "",
      bonus_amount: form.bonusAmount.trim() ? Number(form.bonusAmount) : null,
    } : {};
    let path: string;
    if (editing) {
      try {
        await patch(`referrals/${idOf(referral!.path)}`, { ...base, ...manage }, etag ?? referral!.etag);
      } catch (e) {
        // Lost race: HR moved the status (or linked the hire) while the referrer had their own edit open.
        if (isConflict(e)) {
          const fresh = await get<Referral>(`referrals/${idOf(referral!.path)}`).catch(() => null);
          if (fresh) setEtag(fresh.etag);
          throw new Error("Somebody else changed this referral while you had it open. Press Save again to keep your version.");
        }
        throw e;
      }
      path = referral!.path;
    } else {
      const row = await create<Referral>("referrals", base);
      path = row.path;
    }
    if (file) await upload(`referrals/${idOf(path)}`, file);
    toast({ title: editing ? "Referral updated" : "Referral submitted 🎉", variant: "success" });
    onSaved();
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title={editing ? "Edit referral" : "Refer a candidate"}
      description={canManage
        ? "HR's view: the status and the linked hire are what make the bonus awardable."
        : "Recruiting sees the name and screens them. You keep the referral either way - the bonus follows the hire, not the introduction."}
      collection="referrals"
      objectPath={referral?.path}
      guardLabel="referral"
      form={{ ...form, resume: file ? `${file.name}:${file.size}` : null }}
      draftKey={editing ? undefined : "referral:new"}
      applyDraft={editing ? undefined : (d) => setForm({ name: d.name, email: d.email, phone: d.phone, position: d.position, dept: d.dept, notes: d.notes, status: d.status, hired: d.hired, bonusAmount: d.bonusAmount })}
      onStartOver={editing ? undefined : () => { setForm(EMPTY_REFERRAL); setFile(null); }}
      submitLabel={editing ? "Save changes" : "Submit referral"}
      canSubmit={canSubmit}
      whyNot={[!form.name.trim() && "Give the candidate's name.", !!emailError && "Fix the email address."]}
      onSubmit={submit}
      footerStart={
        <div className="flex min-w-0 items-center gap-2">
          {editing && <Button type="button" variant="ghost" size="sm" onClick={copyLink}><Link2 className="h-4 w-4" /> Copy link</Button>}
          {!canManage && <span className="truncate text-xs text-muted-foreground">{bonusPreview}</span>}
        </div>
      }
    >
      <FieldRow>
        <Field label="Candidate name" field="candidate_name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="Position (optional)" field="position_title" hint={openRoles.length ? "Pick an open role below, or type anything." : "The role you think they fit."}>
          <Input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} placeholder="e.g. Senior Engineer" />
          {openRoles.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {openRoles.map((r) => (
                <button
                  key={r.path}
                  type="button"
                  onClick={() => setForm({ ...form, position: r.title ?? "", dept: r.department ? idOf(r.department) : form.dept })}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs transition-colors",
                    form.position === r.title ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {r.title}
                </button>
              ))}
            </div>
          )}
        </Field>
      </FieldRow>
      {(twin || inPool) && (
        <div className="-mt-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          {twin
            ? `${twin.candidate_name} was already referred${twin.referrer ? ` by ${empName(twin.referrer)}` : ""}${twin.create_time ? ` on ${fmtDate(twin.create_time)}` : ""} (${(STATUS_META[twin.status]?.label ?? twin.status).toLowerCase()}). A second referral for one person isn't paid twice.`
            : `${inPool!.name} is already in the candidate pool, so they're being looked at. Referring them again won't add a bonus.`}
        </div>
      )}
      <FieldRow>
        <Field label="Email (optional)" field="candidate_email" error={emailError} hint="Lets recruiting reach them without going back through you.">
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Phone (optional)" field="candidate_phone"><Input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
      </FieldRow>
      <Field label="Department (optional)" field="department">
        <Select value={form.dept || "none"} onValueChange={(v) => setForm({ ...form, dept: v === "none" ? "" : v })}>
          <SelectTrigger><SelectValue placeholder="Any" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Any / unsure</SelectItem>
            {departments.map((d) => <SelectItem key={d.path} value={idOf(d.path)}>{d.display_name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Notes (optional)" field="notes" hint="What you've seen them do. This is the part a recruiter actually reads.">
        <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Why they'd be a great fit…" />
      </Field>
      <Field
        label={referral?.has_resume ? "Replace resume (optional)" : "Resume (optional)"}
        hint={referral?.has_resume ? "Uploading replaces the resume on file." : "A referral with a resume gets screened days sooner."}
      >
        <FileDropField file={file} onFile={setFile} accept=".pdf,.doc,.docx,application/pdf" hint="PDF or Word" />
      </Field>
      {!canManage && (
        <p className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <Gift className="mr-1 inline h-3.5 w-3.5" />
          Your bonus: {bonusPreview} Nothing is owed if they withdraw or aren't hired.
        </p>
      )}

      {canManage && (
        <div className="mt-2 space-y-4 rounded-lg border bg-muted/20 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Hiring &amp; bonus (HR)</p>
          <FieldRow>
            <Field label="Status" field="status" hint={STATUS_EFFECT[form.status]}>
              <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{STATUS_META[s].label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field
              label="Bonus amount (optional)"
              field="bonus_amount"
              hint={form.bonusAmount.trim() ? "An override: it wins over the policy and any join-speed tier." : `Policy: ${bonusPreview}`}
            >
              <MoneyInput value={form.bonusAmount} onChange={(v) => setForm({ ...form, bonusAmount: v })} placeholder="Default from settings" />
            </Field>
          </FieldRow>
          <Field
            label="Hired employee (milestone anchor)"
            field="hired_employee"
            hint={form.hired ? "The milestone job watches this person's start and probation dates." : "Without a linked hire there is nothing to measure the milestone against, so the bonus can't be awarded."}
          >
            <Combobox
              value={form.hired || "none"}
              onValueChange={(v) => setForm({ ...form, hired: v === "none" ? "" : v })}
              options={[{ value: "none", label: "Not hired yet" }, ...employees.map((e) => ({ value: idOf(e.path), label: `${e.first_name} ${e.last_name}`.trim() }))]}
              placeholder="Not hired yet"
              searchPlaceholder="Search people…"
              emptyText="No one matches."
            />
          </Field>
          {(form.status === "hired" || form.status === "joined") && !form.hired && (
            <p className="text-xs text-warning dark:text-warning">
              <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
              Marked as {STATUS_META[form.status]?.label.toLowerCase()} with nobody linked - the bonus stays stuck at pending until the employee is picked.
            </p>
          )}
        </div>
      )}

      {referral && <ActivitySection resource={referral.path} className="border-t pt-3" />}
    </WriteDialog>
  );
}
