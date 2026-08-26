import { useMemo, useState } from "react";
import { AlertTriangle, FileSignature, FileText, Link2, Plus, Check, Send, Ban, Pencil, Trash2, Hourglass, ThumbsUp } from "lucide-react";
import { create, get, patch, remove, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, idOf } from "@/lib/utils";
import { useMoney, useOrg } from "@/lib/org";
import { isConflict } from "@/lib/formError";
import { navigate, recordUrl, setRouteRecord } from "@/router";
import type { Me, Offer, Application, Candidate, JobRequisition, PayGrade } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { useIntent } from "@/lib/intent";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { useKpiFocus } from "@/lib/kpiFocus";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WriteDialog } from "@/components/common/WriteDialog";
import { OFFER_STATUS_META, type OfferStatusVariant } from "@/lib/ats";
import { PdfPreviewDialog, type PdfSource } from "@/components/common/PdfPreviewDialog";
import { MoneyInput } from "@/components/common/MoneyInput";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");
// The offer workflow's labels are shared with the pipeline board (a card shows its offer's state), so they
// live in lib/ats.ts.
type Variant = OfferStatusVariant;
const STATUS_META = OFFER_STATUS_META;
// An extended offer with no reply after this long has gone quiet: chase it.
const SILENT_DAYS = 7;
const PAST_TENSE: Record<string, string> = { approve: "approved", extend: "extended", accept: "accepted", decline: "declined", rescind: "rescinded" };

// The offer state machine's happy path. Rendered as a mini step trail under the status badge so
// where an offer sits in draft → approved → extended → accepted is visible at a glance.
const PATH = ["draft", "approved", "extended", "accepted"] as const;

function OfferPath({ status }: { status: string }) {
  const idx = PATH.indexOf(status as (typeof PATH)[number]);
  if (idx < 0) return null; // declined / rescinded: the badge alone tells the story
  return (
    <div className="mt-1.5 flex items-center gap-1" aria-hidden>
      {PATH.map((step, i) => (
        <span
          key={step}
          title={STATUS_META[step].label}
          className={cn("h-1.5 rounded-full", i === idx ? "w-4 bg-primary" : "w-1.5", i < idx && "bg-primary/40", i > idx && "bg-muted-foreground/25")}
        />
      ))}
    </div>
  );
}

export default function Offers({ me: _me, openId }: { me: Me; openId?: string }) {
  const { rows, state, error, reload } = useCollection<Offer>("offers");
  const { toast } = useToast();
  const confirm = useConfirm();
  const money = useMoney();
  const [dialog, setDialog] = useState<Offer | "new" | null>(null);
  // Who the offer is for, and for which role: label lists, read only when there is an offer to label or a
  // dialog offering the choice. Same rule as the interview schedule.
  const labelled = rows.length > 0 || dialog !== null;
  const { rows: apps } = useCollection<Application>("applications", { enabled: labelled });
  const { rows: candidates } = useCollection<Candidate>("candidates", { enabled: labelled });
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions", { enabled: labelled });
  useDeepOpen(openId, rows, setDialog);
  // An offer being negotiated over chat is pasteable; `useDeepOpen` above reads the id back in.
  function openDialog(d: Offer | "new") { setDialog(d); setRouteRecord(d === "new" ? null : idOf(d.path)); }
  function closeDialog() { setDialog(null); setRouteRecord(null); setPrefillApp(""); }
  // The offer letter, read in the app before it goes anywhere: rendered from the offer itself, so the letter
  // and the record cannot disagree.
  const [letter, setLetter] = useState<PdfSource | null>(null);
  function openLetter(o: Offer) {
    const l = label(o.application);
    setLetter({
      path: `offers/${idOf(o.path)}`,
      verb: "letter",
      title: `Offer letter · ${l.cand}`,
      description: "Rendered from this offer - the figure, the dates and the signatory come from the record and the org's letter defaults.",
      fileName: `${l.cand} - Offer letter.pdf`,
      allowSave: true,
    });
  }
  // "Make an offer" on the pipeline drawer lands here with the form open on that candidate.
  const [prefillApp, setPrefillApp] = useState("");
  useIntent("new-offer", (arg) => { setPrefillApp(typeof arg === "string" ? arg : ""); setDialog("new"); });

  const label = useMemo(() => {
    const cName = new Map(candidates.map((c) => [idOf(c.path), c.name]));
    const rTitle = new Map(reqs.map((r) => [idOf(r.path), r.title]));
    const m = new Map(apps.map((a) => [idOf(a.path), a]));
    return (appRef?: string) => {
      const a = appRef ? m.get(idOf(appRef)) : undefined;
      const cand = a?.candidate ? cName.get(idOf(a.candidate)) ?? "Candidate" : "";
      const job = a?.requisition ? rTitle.get(idOf(a.requisition)) ?? "" : "";
      return { cand, job };
    };
  }, [apps, candidates, reqs]);

  const items = useMemo(() => [...rows].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? "")), [rows]);

  // An extended offer nobody has replied to for a week is the one to chase; a signed offer with a join date in
  // this month is the one onboarding has to prepare for. Both are clicks, not sums the reader has to do.
  const silentDays = (o: Offer) => (Date.now() - Date.parse(o.update_time ?? o.create_time ?? "")) / 86400000;
  const isSilent = (o: Offer) => o.status === "extended" && silentDays(o) > SILENT_DAYS;
  const isJoiningThisMonth = (o: Offer) => {
    if (o.status !== "accepted" || !o.join_time) return false;
    const d = new Date(o.join_time), n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth();
  };
  const needsMyApproval = (o: Offer) => o.status === "draft" && (o.access?.can ?? []).includes("approve");
  const kf = useKpiFocus<Offer, "extended" | "pipeline" | "accepted" | "closed" | "silent" | "joining" | "approve">({
    extended: { label: "offers awaiting a reply", match: (o) => o.status === "extended" },
    pipeline: { label: "offers in draft or approval", match: (o) => o.status === "draft" || o.status === "approved" },
    accepted: { label: "accepted offers", match: (o) => o.status === "accepted" },
    closed: { label: "declined or rescinded offers", match: (o) => o.status === "declined" || o.status === "rescinded" },
    silent: { label: `offers unanswered for over ${SILENT_DAYS} days`, match: isSilent },
    joining: { label: "hires joining this month", match: isJoiningThisMonth },
    approve: { label: "offers awaiting your approval", match: needsMyApproval },
  });
  const shown = useMemo(() => kf.apply(items), [items, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

  // The candidate behind an offer's application - accept needs their email to mint the employee account.
  const candFor = useMemo(() => {
    const byId = new Map(candidates.map((c) => [idOf(c.path), c]));
    const appById = new Map(apps.map((a) => [idOf(a.path), a]));
    return (appRef?: string) => {
      const a = appRef ? appById.get(idOf(appRef)) : undefined;
      return a?.candidate ? byId.get(idOf(a.candidate)) : undefined;
    };
  }, [apps, candidates]);

  async function act(o: Offer, verb: string, opts?: { confirm?: string; description?: string; confirmLabel?: string; destructive?: boolean }) {
    if (opts?.confirm && !(await confirm({ title: opts.confirm, description: opts.description, destructive: opts.destructive, confirmLabel: opts.confirmLabel ?? "Confirm" }))) return;
    try { await invoke(`offers/${idOf(o.path)}`, verb); toast({ title: `Offer ${PAST_TENSE[verb] ?? verb}`, variant: "success" }); reload(); }
    catch (e) { toast({ title: `Couldn't ${verb} the offer`, description: (e as Error).message, variant: "destructive" }); }
  }

  async function accept(o: Offer) {
    const cand = candFor(o.application);
    if (cand && !cand.email) {
      toast({
        title: "The candidate needs an email first",
        description: `Accepting creates ${cand.name}'s employee account from their email. Add one on the Candidates page, then accept.`,
        variant: "destructive",
      });
      return;
    }
    await act(o, "accept", {
      confirm: `Accept this offer${cand ? ` for ${cand.name}` : ""}?`,
      description: "This converts the candidate into an employee and starts their onboarding. It can't be undone.",
      confirmLabel: "Accept offer",
    });
  }
  async function del(o: Offer) {
    if (!(await confirm({ title: "Delete this offer?", destructive: true, confirmLabel: "Delete" }))) return;
    try { await remove(`offers/${idOf(o.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't delete", description: (e as Error).message, variant: "destructive" }); }
  }

  // An application with a live offer shouldn't get a second one - edit or rescind the existing offer instead.
  const offerableApps = useMemo(() => {
    const hasLiveOffer = new Set(rows.filter((o) => o.application && o.status !== "declined" && o.status !== "rescinded").map((o) => idOf(o.application!)));
    return apps.filter((a) => a.status === "active" && !hasLiveOffer.has(idOf(a.path)));
  }, [apps, rows]);
  const newBtn = (
    <AccessAction collection="offers" create label="Create an offer">
      <Button onClick={() => openDialog("new")}><Plus className="h-4 w-4" /> New offer</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Offers" description="Take offers from draft through approval to a signed-on hire." actions={newBtn} />

      <DataState state={state} error={error} onRetry={reload}>
        {items.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Awaiting candidate", value: items.filter((o) => o.status === "extended").length, icon: Hourglass, tone: items.some((o) => o.status === "extended") ? "warning" : "muted", hint: "no reply yet", ...kf.kpi("extended") },
              ...(items.some(isSilent)
                ? [{ label: `Silent over ${SILENT_DAYS}d`, value: items.filter(isSilent).length, icon: Hourglass, tone: "destructive" as const, hint: "chase the candidate", ...kf.kpi("silent") }]
                : []),
              ...(items.some(needsMyApproval)
                ? [{ label: "Awaiting your approval", value: items.filter(needsMyApproval).length, icon: FileSignature, tone: "warning" as const, hint: "yours to approve", ...kf.kpi("approve") }]
                : []),
              { label: "In draft / approval", value: items.filter((o) => o.status === "draft" || o.status === "approved").length, icon: FileSignature, hint: "not out yet", ...kf.kpi("pipeline") },
              { label: "Accepted", value: items.filter((o) => o.status === "accepted").length, icon: ThumbsUp, tone: "success", hint: "signed on", ...kf.kpi("accepted") },
              ...(items.some(isJoiningThisMonth)
                ? [{ label: "Joining this month", value: items.filter(isJoiningThisMonth).length, icon: ThumbsUp, tone: "primary" as const, hint: "prepare onboarding", ...kf.kpi("joining") }]
                : []),
              { label: "Declined", value: items.filter((o) => o.status === "declined" || o.status === "rescinded").length, tone: "muted", hint: "incl. rescinded", ...kf.kpi("closed") },
            ]}
          />
        )}
        {items.length === 0 ? (
          <EmptyState illustration="signed" icon={FileSignature} title="No offers yet" description="Create an offer for a candidate you want to hire." action={newBtn} />
        ) : (
          <div className="scroll-shadow-x overflow-x-auto rounded-lg border">
            {/* Labelled blocks below `sm`, a table from there up (`.table-stack`). */}
            <table className="table-stack w-full text-sm">
              <thead><tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Candidate</th>
                <th className="px-3 py-2 font-medium">Comp</th>
                <th className="px-3 py-2 font-medium">Join date</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    No {kf.activeLabel ?? "offers"}.{" "}
                    <button type="button" className="font-medium text-primary underline-offset-2 hover:underline" onClick={kf.clear}>Show all offers</button>
                  </td></tr>
                )}
                {shown.map((o) => {
                  const can = o.access?.can ?? [];
                  const l = label(o.application);
                  const sm = STATUS_META[o.status] ?? { label: o.status, variant: "secondary" as Variant };
                  return (
                    <tr key={o.path} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2">
                        {candFor(o.application)
                          ? <button type="button" className="text-left font-medium hover:underline" onClick={() => navigate(`candidates/${idOf(candFor(o.application)!.path)}`)}>{l.cand}</button>
                          : <div className="font-medium">{l.cand}</div>}
                        <div className="text-xs text-muted-foreground">{l.job}</div>
                      </td>
                      <td data-label="Comp" className="px-3 py-2 tabular-nums">{money(o.base_comp, o.currency_code)}</td>
                      <td data-label="Join date" className="px-3 py-2 text-muted-foreground">{fmtDate(o.join_time)}</td>
                      {/* Wrapped: badge, path and expiry are one value, and a stacked row lays its value out
                          as a single column beside the label. */}
                      <td data-label="Status" className="px-3 py-2">
                        <span className="inline-block text-right sm:text-left">
                          <Badge variant={sm.variant}>{sm.label}</Badge>
                          <OfferPath status={o.status} />
                          {o.status === "extended" && o.expiry_time && (
                            <span className={cn("mt-1 block text-xs", +new Date(o.expiry_time) < Date.now() ? "font-medium text-destructive" : "text-muted-foreground")}>
                              {+new Date(o.expiry_time) < Date.now() ? "Expired" : "Expires"} {fmtDate(o.expiry_time)}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {o.status === "draft" && can.includes("approve") && <AccessAction verb="approve" objectPath={o.path} can={can} label="Approve offer"><Button size="sm" variant="outline" className="h-7" onClick={() => act(o, "approve")}><Check className="h-3.5 w-3.5" /> Approve</Button></AccessAction>}
                          {o.status === "approved" && can.includes("extend") && <AccessAction verb="extend" objectPath={o.path} can={can} label="Extend offer"><Button size="sm" variant="outline" className="h-7" onClick={() => act(o, "extend", { confirm: "Extend this offer to the candidate?", confirmLabel: "Extend offer" })}><Send className="h-3.5 w-3.5" /> Extend</Button></AccessAction>}
                          {o.status === "extended" && can.includes("accept") && <AccessAction verb="accept" objectPath={o.path} can={can} label="Accept offer"><Button size="sm" variant="outline" className="h-7" onClick={() => accept(o)}><Check className="h-3.5 w-3.5" /> Accept</Button></AccessAction>}
                          {o.status === "extended" && can.includes("decline") && <AccessAction verb="decline" objectPath={o.path} can={can} label="Decline offer"><Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => act(o, "decline", { confirm: "Mark this offer declined?", confirmLabel: "Mark declined" })}>Decline</Button></AccessAction>}
                          {["draft", "approved", "extended"].includes(o.status) && can.includes("rescind") && <AccessAction verb="rescind" objectPath={o.path} can={can} label="Rescind offer"><Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => act(o, "rescind", { confirm: "Rescind this offer?", description: "This withdraws the offer from the candidate.", destructive: true, confirmLabel: "Rescind" })} aria-label="Rescind"><Ban className="h-3.5 w-3.5" /></Button></AccessAction>}
                          {can.includes("letter") && (
                            <AccessAction verb="letter" objectPath={o.path} can={can} label="Offer letter">
                              <Button size="sm" variant="ghost" className="h-7" onClick={() => openLetter(o)} aria-label="Offer letter" title="Read the offer letter"><FileText className="h-3.5 w-3.5" /></Button>
                            </AccessAction>
                          )}
                          {o.status === "draft" && can.includes("update") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openDialog(o)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
                          {can.includes("delete") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => del(o)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
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

      <PdfPreviewDialog source={letter} onClose={() => setLetter(null)} />
      {dialog && (
        <OfferDialog
          offer={dialog === "new" ? null : dialog}
          defaultApplication={prefillApp}
          apps={offerableApps}
          label={label}
          candFor={candFor}
          onClose={closeDialog}
          onSaved={() => { closeDialog(); reload(); }}
        />
      )}
    </div>
  );
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
/** The 1st of the month after `ymd` - how joining dates are actually agreed. */
const firstOfNextMonth = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};
const isWeekend = (ymd: string) => [0, 6].includes(new Date(`${ymd}T00:00:00Z`).getUTCDay());

/** One-tap date, so a fortnight's expiry isn't three clicks in a date picker. */
function DateChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
      {label}
    </button>
  );
}

function OfferDialog({ offer, defaultApplication, apps, label, candFor, onClose, onSaved }: {
  offer: Offer | null;
  /** Pre-picked application, when the dialog was opened from a pipeline card. */
  defaultApplication?: string;
  apps: Application[];
  label: (ref?: string) => { cand: string; job: string };
  candFor: (ref?: string) => Candidate | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { org } = useOrg();
  const money = useMoney();
  const editing = !!offer;
  // Single-currency by design (the org's default): a payroll run refuses a mixed-currency hire, so an offer in
  // another currency is a hire that cannot be paid. Existing rows keep whatever they were written with.
  const currency = offer?.currency_code || org.default_currency || "INR";
  const [form, setForm] = useState({
    application: offer?.application ? idOf(offer.application) : defaultApplication ?? "",
    comp: offer?.base_comp != null ? String(offer.base_comp) : "",
    offerDate: offer?.offer_time ? offer.offer_time.slice(0, 10) : todayStr(),
    joinDate: offer?.join_time ? offer.join_time.slice(0, 10) : "",
    expiry: offer?.expiry_time ? offer.expiry_time.slice(0, 10) : "",
    notes: offer?.notes ?? "",
  });
  // The version an edit writes against, refreshed from the server when a save loses a race.
  const [etag, setEtag] = useState(offer?.etag);

  const compError = form.comp !== "" && !(Number(form.comp) > 0) ? "Must be more than zero." : undefined;
  const joinError = form.offerDate && form.joinDate && form.joinDate < form.offerDate ? "Must be on or after the offer date." : undefined;
  const expiryError = form.offerDate && form.expiry && form.expiry < form.offerDate ? "Must be on or after the offer date." : undefined;
  const canSubmit = (editing || !!form.application) && !compError && !joinError && !expiryError;

  const appRef = form.application ? `applications/${form.application}` : offer?.application;
  const cand = candFor(appRef);
  const l = label(appRef);
  const annual = Number(form.comp);
  const monthly = Number.isFinite(annual) && annual > 0 ? annual / 12 : null;

  // The grade ladder, fetched with the dialog rather than the page: only this form asks about bands.
  const { rows: grades } = useCollection<PayGrade>("pay-grades");
  const [gradeId, setGradeId] = useState("");
  const sortedGrades = useMemo(() => [...grades].filter((g) => !g.delete_time).sort((a, b) => (a.level ?? 0) - (b.level ?? 0)), [grades]);
  const grade = sortedGrades.find((g) => idOf(g.path) === gradeId) ?? null;
  // Mirrors the server's own band verdict (see http/serialize.ts#toCompensationResource): the annual figure
  // against band min/max, and the compa-ratio against the midpoint. Same rule, said before the hire exists.
  const band = useMemo(() => {
    if (!grade || !(annual > 0)) return null;
    const min = grade.band_min ?? null, mid = grade.band_mid ?? null, max = grade.band_max ?? null;
    if (min == null && max == null) return null;
    const status = min != null && annual < min ? "below" : max != null && annual > max ? "above" : "in_band";
    const lo = min ?? (mid != null ? mid * 0.8 : annual * 0.8);
    const hi = max ?? (mid != null ? mid * 1.2 : annual * 1.2);
    const pct = hi > lo ? ((annual - lo) / (hi - lo)) * 100 : 50;
    return { status, min, mid, max, compa: mid ? annual / mid : null, pct };
  }, [grade, annual]);

  // Read the dates back as spans, which is how they are argued about ("two weeks to decide", "joins in a month").
  const expiryIn = form.expiry ? daysBetween(todayStr(), form.expiry) : null;
  const joinIn = form.joinDate ? daysBetween(todayStr(), form.joinDate) : null;
  const expiryAfterJoin = !!form.expiry && !!form.joinDate && form.expiry > form.joinDate;

  const consequence = [
    monthly ? `${money(annual, currency)} a year` : "no figure yet",
    joinIn != null ? (joinIn >= 0 ? `joins in ${joinIn}d` : `join date ${-joinIn}d ago`) : "",
    expiryIn != null ? (expiryIn >= 0 ? `expires in ${expiryIn}d` : "already expired") : "",
  ].filter(Boolean).join(" · ");

  function copyLink() {
    navigator.clipboard.writeText(recordUrl("offers", idOf(offer!.path))).then(
      () => toast({ title: "Link copied", description: "Anyone who can see this offer can open it." }),
      () => toast({ title: "Couldn't copy the link", variant: "destructive" }),
    );
  }

  async function submit() {
    const body: Record<string, unknown> = {
      base_comp: form.comp ? Number(form.comp) : null,
      currency_code: currency,
      offer_date: form.offerDate || null,
      join_date: form.joinDate || null,
      expiry_date: form.expiry || null,
      notes: form.notes.trim() || null,
    };
    if (editing) {
      try {
        await patch(`offers/${idOf(offer!.path)}`, body, etag ?? offer!.etag);
      } catch (e) {
        // Lost race: somebody approved or extended it while this was open (the server then refuses the edit
        // outright, which is the right answer - the reader is told what happened either way).
        if (isConflict(e)) {
          const fresh = await get<Offer>(`offers/${idOf(offer!.path)}`).catch(() => null);
          if (fresh) setEtag(fresh.etag);
          throw new Error("Somebody else changed this offer while you had it open. Press Save again to keep your version.");
        }
        throw e;
      }
    } else {
      body.application = `applications/${form.application}`;
      await create<Offer>("offers", body);
    }
    toast({ title: editing ? "Offer updated" : "Offer created", variant: "success" });
    onSaved();
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title={editing ? "Edit offer" : "Create an offer"}
      description="A draft goes for approval, then out to the candidate. Accepting creates their employee record, seeds their compensation from this figure and opens onboarding - so this is the number payroll will run."
      collection="offers"
      objectPath={offer?.path}
      guardLabel="offer"
      form={form}
      draftKey={editing ? undefined : "offer:new"}
      applyDraft={editing ? undefined : (d) => setForm(d)}
      onStartOver={editing ? undefined : () => setForm({ application: "", comp: "", offerDate: todayStr(), joinDate: "", expiry: "", notes: "" })}
      submitLabel={editing ? "Save changes" : "Create offer"}
      canSubmit={canSubmit}
      whyNot={[
        !editing && !form.application && "Pick who the offer is for.",
        !!compError && "The compensation has to be more than zero.",
        !!joinError && "The join date is before the offer date.",
        !!expiryError && "The expiry is before the offer date.",
      ]}
      onSubmit={submit}
      footerStart={
        <div className="flex min-w-0 items-center gap-2">
          {editing && <Button type="button" variant="ghost" size="sm" onClick={copyLink}><Link2 className="h-4 w-4" /> Copy link</Button>}
          <span className="truncate text-xs text-muted-foreground">{consequence}</span>
        </div>
      }
    >
      {!editing ? (
        <Field label="Application" field="application">
          <Combobox
            value={form.application}
            onValueChange={(v) => setForm({ ...form, application: v })}
            options={apps.map((a) => { const al = label(a.path); return { value: idOf(a.path), label: `${al.cand} · ${al.job}` }; })}
            placeholder="Pick an active application"
            searchPlaceholder="Search candidates…"
            emptyText="No active applications to offer on."
            autoFocus
          />
        </Field>
      ) : (
        <p className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {[l.cand, l.job].filter(Boolean).join(" · ")} · only a draft can be edited; use extend or rescind once it's out.
        </p>
      )}
      {/* Accepting mints the employee account from the candidate's email, so a missing one turns into a failed
          hire at the worst moment. Said here, where it can still be fixed cheaply. */}
      {cand && !cand.email && (
        <p className="-mt-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          {cand.name} has no email on file. Accepting creates their employee account from it, so acceptance will fail until it's added on the candidate.
        </p>
      )}
      <Field
        label="Compensation (annual)"
        field="base_comp"
        error={compError}
        hint={monthly ? `About ${money(monthly, currency)} a month. This becomes their CTC on the day they join.` : `Annual cost to company, in ${currency}.`}
      >
        <MoneyInput value={form.comp} onChange={(v) => setForm({ ...form, comp: v })} currency={currency} autoFocus={editing} suffix="a year" />
      </Field>
      {/* Until now the offered figure was checked against nothing, and it becomes the hire's CTC verbatim. The
          grade ladder already holds the band this role is paid in, so the check belongs here - before the
          approval, not in a compensation review three months later. Ephemeral: an offer stores no grade. */}
      {grades.length > 0 && (
        <Field
          label="Band check (optional)"
          hint={grade
            ? "Bands are guardrails, not limits: out-of-band is worth a conversation, never blocked."
            : "Pick the grade this role is paid in to see where the offer sits in its band."}
        >
          <Select value={gradeId || "none"} onValueChange={(v) => setGradeId(v === "none" ? "" : v)}>
            <SelectTrigger className="w-full sm:w-64"><SelectValue placeholder="Not checked" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Not checked</SelectItem>
              {sortedGrades.map((g) => <SelectItem key={g.path} value={idOf(g.path)}>{g.display_name}{g.level != null ? ` · L${g.level}` : ""}</SelectItem>)}
            </SelectContent>
          </Select>
          {band && (
            <div className="mt-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">
                  {band.status === "below" ? "Below the band" : band.status === "above" ? "Above the band" : "In band"}
                  {band.compa != null && <span className="ml-1 tabular-nums text-muted-foreground">· compa-ratio {band.compa.toFixed(2)}×</span>}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {[band.min != null ? money(band.min, currency) : "", band.mid != null ? `mid ${money(band.mid, currency)}` : "", band.max != null ? money(band.max, currency) : ""].filter(Boolean).join(" · ")}
                </span>
              </div>
              {/* The offer's position in the band, as a position rather than a paragraph. */}
              <div className="relative mt-2 h-1.5 rounded-full bg-muted">
                <div
                  className={cn("absolute -top-1 h-3.5 w-1 rounded-full", band.status === "in_band" ? "bg-success" : "bg-warning")}
                  style={{ left: `${Math.min(100, Math.max(0, band.pct))}%` }}
                  aria-hidden
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {band.status === "above"
                  ? `${money(annual - (band.max ?? 0), currency)} above the top of the band - that is a compa-ratio conversation before approval, and it sets the floor for everyone hired after them.`
                  : band.status === "below"
                    ? `${money((band.min ?? 0) - annual, currency)} below the bottom of the band - an offer people leave from inside a year.`
                    : "Inside the band this grade is paid in."}
              </p>
            </div>
          )}
        </Field>
      )}
      <FieldRow>
        <Field label="Offer date" field="offer_date" hint="The day the paperwork is dated.">
          <Input type="date" value={form.offerDate} onChange={(e) => setForm({ ...form, offerDate: e.target.value })} />
        </Field>
        <Field
          label="Join date"
          field="join_date"
          error={joinError}
          hint="Becomes their start date, which is what onboarding and their first payroll run work from."
        >
          <Input type="date" value={form.joinDate} min={form.offerDate || undefined} onChange={(e) => setForm({ ...form, joinDate: e.target.value })} />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <DateChip label="1st of next month" onClick={() => setForm({ ...form, joinDate: firstOfNextMonth(form.offerDate || todayStr()) })} />
            <DateChip label="In 30 days" onClick={() => setForm({ ...form, joinDate: addDays(form.offerDate || todayStr(), 30) })} />
            <DateChip label="In 60 days" onClick={() => setForm({ ...form, joinDate: addDays(form.offerDate || todayStr(), 60) })} />
          </div>
        </Field>
      </FieldRow>
      {form.joinDate && isWeekend(form.joinDate) && (
        <p className="-mt-1 text-xs text-muted-foreground">That join date is a weekend - their first working day would be the Monday after.</p>
      )}
      <Field
        label="Offer expiry (optional)"
        field="expiry_date"
        error={expiryError}
        hint="A deadline is what turns a silent offer into a decision; the list flags one that has passed."
      >
        <Input type="date" value={form.expiry} min={form.offerDate || undefined} onChange={(e) => setForm({ ...form, expiry: e.target.value })} />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <DateChip label="A week" onClick={() => setForm({ ...form, expiry: addDays(form.offerDate || todayStr(), 7) })} />
          <DateChip label="A fortnight" onClick={() => setForm({ ...form, expiry: addDays(form.offerDate || todayStr(), 14) })} />
          {form.expiry && <DateChip label="Clear" onClick={() => setForm({ ...form, expiry: "" })} />}
        </div>
      </Field>
      {expiryAfterJoin && (
        <p className="-mt-1 text-xs text-warning dark:text-warning">
          The offer expires after the join date, so it could lapse on a day they were meant to already be working.
        </p>
      )}
      <Field label="Notes (optional)" field="notes" hint="What was agreed on the call: joining bonus, notice buy-out, relocation.">
        <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </Field>
      {offer && <ActivitySection resource={offer.path} className="border-t pt-3" />}
    </WriteDialog>
  );
}
