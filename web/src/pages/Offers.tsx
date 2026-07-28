import { useMemo, useState } from "react";
import { FileSignature, Plus, Check, Send, Ban, Pencil, Trash2, Hourglass, ThumbsUp } from "lucide-react";
import { create, patch, remove, invoke } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { cn, idOf } from "@/lib/utils";
import { useMoney } from "@/lib/org";
import { navigate } from "@/router";
import type { Me, Offer, Application, Candidate, JobRequisition } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");
type Variant = "secondary" | "success" | "destructive" | "outline";
const STATUS_META: Record<string, { label: string; variant: Variant }> = {
  draft: { label: "Draft", variant: "outline" },
  approved: { label: "Approved", variant: "secondary" },
  extended: { label: "Extended", variant: "secondary" },
  accepted: { label: "Accepted", variant: "success" },
  declined: { label: "Declined", variant: "destructive" },
  rescinded: { label: "Rescinded", variant: "destructive" },
};
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
  const { rows: apps } = useCollection<Application>("applications");
  const { rows: candidates } = useCollection<Candidate>("candidates");
  const { rows: reqs } = useCollection<JobRequisition>("job-requisitions");
  const { toast } = useToast();
  const confirm = useConfirm();
  const money = useMoney();
  const [dialog, setDialog] = useState<Offer | "new" | null>(null);
  useDeepOpen(openId, rows, setDialog);

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
      <Button onClick={() => setDialog("new")}><Plus className="h-4 w-4" /> New offer</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Offers" description="Take offers from draft through approval to a signed-on hire." actions={newBtn} />

      <DataState state={state} error={error} onRetry={reload}>
        {items.length > 0 && (
          <SummaryStrip
            items={[
              { label: "Awaiting candidate", value: items.filter((o) => o.status === "extended").length, icon: Hourglass, tone: items.some((o) => o.status === "extended") ? "warning" : "muted", hint: "extended, no reply yet" },
              { label: "In draft / approval", value: items.filter((o) => o.status === "draft" || o.status === "approved").length, icon: FileSignature },
              { label: "Accepted", value: items.filter((o) => o.status === "accepted").length, icon: ThumbsUp, tone: "success" },
              { label: "Declined", value: items.filter((o) => o.status === "declined" || o.status === "rescinded").length, tone: "muted", hint: "incl. rescinded" },
            ]}
          />
        )}
        {items.length === 0 ? (
          <EmptyState illustration="signed" icon={FileSignature} title="No offers yet" description="Create an offer for a candidate you want to hire." action={newBtn} />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Candidate</th>
                <th className="px-3 py-2 font-medium">Comp</th>
                <th className="px-3 py-2 font-medium">Join date</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {items.map((o) => {
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
                      <td className="px-3 py-2 tabular-nums">{money(o.base_comp, o.currency_code)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{fmtDate(o.join_time)}</td>
                      <td className="px-3 py-2">
                        <Badge variant={sm.variant}>{sm.label}</Badge>
                        <OfferPath status={o.status} />
                        {o.status === "extended" && o.expiry_time && (
                          <div className={cn("mt-1 text-xs", +new Date(o.expiry_time) < Date.now() ? "font-medium text-destructive" : "text-muted-foreground")}>
                            {+new Date(o.expiry_time) < Date.now() ? "Expired" : "Expires"} {fmtDate(o.expiry_time)}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {o.status === "draft" && can.includes("approve") && <Button size="sm" variant="outline" className="h-7" onClick={() => act(o, "approve")}><Check className="h-3.5 w-3.5" /> Approve</Button>}
                          {o.status === "approved" && can.includes("extend") && <Button size="sm" variant="outline" className="h-7" onClick={() => act(o, "extend", { confirm: "Extend this offer to the candidate?", confirmLabel: "Extend offer" })}><Send className="h-3.5 w-3.5" /> Extend</Button>}
                          {o.status === "extended" && can.includes("accept") && <Button size="sm" variant="outline" className="h-7" onClick={() => accept(o)}><Check className="h-3.5 w-3.5" /> Accept</Button>}
                          {o.status === "extended" && can.includes("decline") && <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" onClick={() => act(o, "decline", { confirm: "Mark this offer declined?", confirmLabel: "Mark declined" })}>Decline</Button>}
                          {["draft", "approved", "extended"].includes(o.status) && can.includes("rescind") && <Button size="sm" variant="ghost" className="h-7 text-destructive" onClick={() => act(o, "rescind", { confirm: "Rescind this offer?", description: "This withdraws the offer from the candidate.", destructive: true, confirmLabel: "Rescind" })} aria-label="Rescind"><Ban className="h-3.5 w-3.5" /></Button>}
                          {o.status === "draft" && can.includes("update") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setDialog(o)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
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

      {dialog && (
        <OfferDialog
          offer={dialog === "new" ? null : dialog}
          apps={offerableApps}
          label={label}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload(); }}
        />
      )}
    </div>
  );
}

function OfferDialog({ offer, apps, label, onClose, onSaved }: {
  offer: Offer | null;
  apps: Application[];
  label: (ref?: string) => { cand: string; job: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const editing = !!offer;
  const [application, setApplication] = useState(offer?.application ? idOf(offer.application) : "");
  const [comp, setComp] = useState(offer?.base_comp != null ? String(offer.base_comp) : "");
  const [ccy, setCcy] = useState(offer?.currency_code ?? "INR");
  const [offerDate, setOfferDate] = useState(offer?.offer_time ? offer.offer_time.slice(0, 10) : "");
  const [joinDate, setJoinDate] = useState(offer?.join_time ? offer.join_time.slice(0, 10) : "");
  const [expiry, setExpiry] = useState(offer?.expiry_time ? offer.expiry_time.slice(0, 10) : "");
  const [notes, setNotes] = useState(offer?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const compError = comp !== "" && Number(comp) <= 0 ? "Must be more than zero." : undefined;
  const joinError = offerDate && joinDate && joinDate < offerDate ? "Must be on or after the offer date." : undefined;
  const expiryError = offerDate && expiry && expiry < offerDate ? "Must be on or after the offer date." : undefined;
  const valid = (editing || !!application) && !compError && !joinError && !expiryError;

  async function save() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        base_comp: comp ? Number(comp) : null,
        currency_code: ccy.trim() || "INR",
        offer_date: offerDate || null,
        join_date: joinDate || null,
        expiry_date: expiry || null,
        notes: notes.trim() || null,
      };
      if (!editing) body.application = `applications/${application}`;
      if (editing) await patch(`offers/${idOf(offer!.path)}`, body, offer!.etag);
      else await create<Offer>("offers", body);
      toast({ title: editing ? "Updated" : "Offer created", variant: "success" });
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
        <DialogHeader><DialogTitle>{editing ? "Edit offer" : "Create an offer"}</DialogTitle></DialogHeader>
        {!editing && (
          <Field label="Application">
            <Combobox
              value={application}
              onValueChange={setApplication}
              options={apps.map((a) => { const l = label(a.path); return { value: idOf(a.path), label: `${l.cand} · ${l.job}` }; })}
              placeholder="Pick an active application"
              emptyText="No active applications to offer on."
            />
          </Field>
        )}
        <FieldRow>
          <Field label="Compensation (annual)" error={compError}><Input type="number" min={0} value={comp} onChange={(e) => setComp(e.target.value)} autoFocus /></Field>
          <Field label="Currency"><Input value={ccy} onChange={(e) => setCcy(e.target.value)} /></Field>
        </FieldRow>
        <FieldRow>
          <Field label="Offer date"><Input type="date" value={offerDate} onChange={(e) => setOfferDate(e.target.value)} /></Field>
          <Field label="Join date" error={joinError}><Input type="date" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} /></Field>
        </FieldRow>
        <Field label="Offer expiry (optional)" error={expiryError}><Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></Field>
        <Field label="Notes (optional)"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {offer && <ActivitySection resource={offer.path} className="border-t pt-3" />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!valid}>{editing ? "Save" : "Create offer"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
