import { useMemo, useState } from "react";
import { Lightbulb, Plus, ChevronUp, ChevronDown, Trash2, MessageSquare, EyeOff } from "lucide-react";
import { create, invoke, remove } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useIntent } from "@/lib/intent";
import { formatDate, idOf, humanize, cn } from "@/lib/utils";
import type { Suggestion, Employee, Me } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field } from "@/components/common/Field";
import { ActivitySection } from "@/components/common/ActivitySection";
import { useDeepOpen } from "@/hooks/useDeepOpen";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessItem } from "@/components/access/AccessItem";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/common/confirm";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const CATEGORIES = ["Workplace", "Process", "Culture", "Tools & IT", "Benefits", "Other"];
const STATUSES = ["new", "under_review", "planned", "implemented", "declined"];
const statusVariant: Record<string, "secondary" | "warning" | "success" | "muted" | "destructive"> = {
  new: "secondary", under_review: "warning", planned: "secondary", implemented: "success", declined: "muted",
};

export default function Suggestions({ me, openId }: { me: Me; openId?: string }) {
  void me;
  const { rows, state, error, reload } = useCollection<Suggestion>("suggestions");
  const { rows: employees } = useCollection<Employee>("employees");
  const { toast } = useToast();
  const confirm = useConfirm();
  const canSubmit = usePermission("suggestions.write");

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", body: "", category: "", anonymous: false });
  const [busy, setBusy] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState<"new" | "top">("top");
  const [respondFor, setRespondFor] = useState<Suggestion | null>(null);
  useDeepOpen(openId, rows, setRespondFor);

  const emp = (p?: string) => (p ? employees.find((e) => idOf(e.path) === idOf(p)) : undefined);
  const empName = (p?: string) => { const e = emp(p); return e ? `${e.first_name} ${e.last_name}` : ""; };

  const shown = useMemo(() => {
    const list = rows.filter((s) => !statusFilter || s.status === statusFilter);
    const score = (s: Suggestion) => s.upvotes - s.downvotes;
    return [...list].sort((a, b) => (sort === "top" ? score(b) - score(a) || +new Date(b.create_time ?? "") - +new Date(a.create_time ?? "") : +new Date(b.create_time ?? "") - +new Date(a.create_time ?? "")));
  }, [rows, statusFilter, sort]);

  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of rows) m.set(s.status, (m.get(s.status) ?? 0) + 1);
    return m;
  }, [rows]);

  async function submit() {
    setBusy(true);
    try {
      await create("suggestions", { title: form.title.trim(), body: form.body.trim(), category: form.category || null, anonymous: form.anonymous });
      toast({ title: "Suggestion submitted", variant: "success" });
      setForm({ title: "", body: "", category: "", anonymous: false });
      setOpen(false);
      reload();
    } catch (e) { toast({ title: "Couldn't submit", description: (e as Error).message, variant: "destructive" }); }
    finally { setBusy(false); }
  }
  const [voting, setVoting] = useState<string | null>(null);
  async function vote(s: Suggestion, dir: 1 | -1) {
    if (voting) return; // one vote in flight at a time - rapid clicks would race the toggle
    setVoting(s.path);
    try { await invoke(`suggestions/${idOf(s.path)}`, dir === 1 ? "upvote" : "downvote"); await reload(); }
    catch (e) { toast({ title: "Couldn't vote", description: (e as Error).message, variant: "destructive" }); }
    finally { setVoting(null); }
  }
  async function del(s: Suggestion) {
    if (!(await confirm({ title: "Remove this suggestion?", description: `"${s.title}" and its votes will be permanently removed.`, confirmLabel: "Remove", destructive: true }))) return;
    try { await remove(s.path, s.etag); toast({ title: "Suggestion removed", variant: "success" }); reload(); }
    catch (e) { toast({ title: "Couldn't remove", description: (e as Error).message, variant: "destructive" }); }
  }

  useIntent("new-suggestion", () => setOpen(true));

  const addBtn = canSubmit && <AccessAction collection="suggestions" create><Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New suggestion</Button></AccessAction>;

  return (
    <div>
      <PageHeader title="Suggestion Box" description="Share ideas to improve how we work." actions={addBtn} />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {["", ...STATUSES].map((st) => {
            const count = st ? statusCounts.get(st) ?? 0 : rows.length;
            return (
              <button
                key={st || "all"}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  statusFilter === st ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {st ? humanize(st) : "All"} <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto inline-flex rounded-md border bg-background p-0.5">
          {(["top", "new"] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSort(s)} className={`rounded px-3 py-1 text-sm transition-colors ${sort === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>{s === "top" ? "Most upvoted" : "Newest"}</button>
          ))}
        </div>
      </div>

      <DataState state={state} error={error} onRetry={reload}>
        {shown.length === 0 ? (
          rows.length > 0 ? (
            <EmptyState icon={Lightbulb} title={`No ${humanize(statusFilter).toLowerCase()} suggestions`} description="Try another status filter." action={<Button variant="outline" onClick={() => setStatusFilter("")}>Show all</Button>} />
          ) : (
            <EmptyState illustration="feedback" icon={Lightbulb} title="No suggestions yet" description="Have an idea to improve things? Be the first to share it." action={addBtn} />
          )
        ) : (
          <div className="space-y-3">
            {shown.map((s) => {
              const can = s.access?.can ?? [];
              const e = emp(s.submitter);
              return (
                <AccessItem key={s.path} collection="suggestions" objectPath={s.path} can={s.access?.can} why={s.access?.why} label="Suggestion">
                <Card className="flex gap-3 p-4">
                  {s.own ? (
                    // No vote arrows on your own suggestion - the server rejects self-votes.
                    <div className="flex h-fit flex-col items-center gap-0.5 rounded-md border px-2.5 py-1.5" title="You can't vote on your own suggestion">
                      <span className="text-sm font-semibold tabular-nums">{s.upvotes - s.downvotes}</span>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Yours</span>
                    </div>
                  ) : (
                    <div className="flex h-fit flex-col items-center rounded-md border px-2.5 py-1.5">
                      <button type="button" disabled={voting === s.path} onClick={() => vote(s, 1)} className={`rounded transition-colors disabled:opacity-50 ${s.my_vote === 1 ? "text-primary" : "text-muted-foreground hover:text-foreground"}`} title="Upvote">
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <span className="text-sm font-semibold tabular-nums">{s.upvotes - s.downvotes}</span>
                      <button type="button" disabled={voting === s.path} onClick={() => vote(s, -1)} className={`rounded transition-colors disabled:opacity-50 ${s.my_vote === -1 ? "text-destructive" : "text-muted-foreground hover:text-foreground"}`} title="Downvote">
                        <ChevronDown className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{s.title}</span>
                      <Badge variant={statusVariant[s.status]}>{humanize(s.status)}</Badge>
                      {s.category && <Badge variant="outline">{s.category}</Badge>}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{s.body}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {s.anonymous ? <span className="inline-flex items-center gap-1"><EyeOff className="h-3.5 w-3.5" /> Anonymous{s.own ? " (you)" : ""}</span>
                        : <span className="inline-flex items-center gap-1"><PhotoAvatar employeeId={s.submitter ? idOf(s.submitter) : ""} name={empName(s.submitter)} photo={e?.photo} className="h-5 w-5" /> {empName(s.submitter)}</span>}
                      <span>· {formatDate(s.create_time ?? "")}</span>
                    </div>
                    {s.response && (
                      <div className="mt-2 rounded-md border bg-muted/40 p-2 text-sm">
                        <p className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><MessageSquare className="h-3.5 w-3.5" /> Response from HR</p>
                        {s.response}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      {can.includes("respond") && <Button size="sm" variant="outline" onClick={() => setRespondFor(s)}><MessageSquare className="h-3.5 w-3.5" /> Respond</Button>}
                      {can.includes("delete") && <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => del(s)}><Trash2 className="h-3.5 w-3.5" /> Remove</Button>}
                    </div>
                  </div>
                </Card>
                </AccessItem>
              );
            })}
          </div>
        )}
      </DataState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent onEnterSubmit={() => { if (!busy && form.title.trim() && form.body.trim()) submit(); }}>
          <DialogHeader><DialogTitle>New suggestion</DialogTitle></DialogHeader>
          <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="A short summary of your idea" /></Field>
          <Field label="Category" hint="Optional.">
            <Select value={form.category || "none"} onValueChange={(v) => setForm({ ...form, category: v === "none" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="Pick a category…" /></SelectTrigger>
              <SelectContent><SelectItem value="none">None</SelectItem>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Details"><Textarea rows={4} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Describe your suggestion…" /></Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={form.anonymous} onCheckedChange={(v) => setForm({ ...form, anonymous: v === true })} />
            <span className="inline-flex items-center gap-1"><EyeOff className="h-4 w-4" /> Submit anonymously</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.title.trim() || !form.body.trim()}>Submit</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {respondFor && <RespondDialog suggestion={respondFor} onClose={() => setRespondFor(null)} onDone={() => { setRespondFor(null); toast({ title: "Response saved", variant: "success" }); reload(); }} toastErr={(m) => toast({ title: "Couldn't respond", description: m, variant: "destructive" })} />}
    </div>
  );
}

function RespondDialog({ suggestion: s, onClose, onDone, toastErr }: { suggestion: Suggestion; onClose: () => void; onDone: () => void; toastErr: (m: string) => void }) {
  const [status, setStatus] = useState(s.status);
  const [response, setResponse] = useState(s.response ?? "");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await invoke(`suggestions/${idOf(s.path)}`, "respond", undefined, { status, response: response.trim() || null }); onDone(); }
    catch (e) { toastErr((e as Error).message); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader><DialogTitle>Respond to suggestion</DialogTitle></DialogHeader>
        <p className="text-sm font-medium">{s.title}</p>
        <Field label="Status">
          <Select value={status} onValueChange={(v) => setStatus(v as Suggestion["status"])}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{STATUSES.map((x) => <SelectItem key={x} value={x}>{humanize(x)}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Public response" hint="Shown to everyone who can see the suggestion."><Textarea rows={3} value={response} onChange={(e) => setResponse(e.target.value)} placeholder="Optional reply…" autoFocus /></Field>
        <ActivitySection resource={s.path} className="border-t pt-3" />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy}>Save response</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
