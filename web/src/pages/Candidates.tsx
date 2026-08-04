import { useEffect, useMemo, useRef, useState } from "react";
import { Users, Plus, Pencil, Trash2, Paperclip, Download, Search, FileText, UserPlus } from "lucide-react";
import { create, patch, remove, upload, download, get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import { navigate } from "@/router";
import type { Me, Candidate, Application, AtsConfig } from "@/types";
import { DEFAULT_ATS_CONFIG } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Field, FieldRow } from "@/components/common/Field";
import { SummaryStrip } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";

export const sourceLabel = (s?: string) => (s ? s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "");

export function useAtsConfig(): AtsConfig {
  const [cfg, setCfg] = useState<AtsConfig>(DEFAULT_ATS_CONFIG);
  useEffect(() => {
    get<{ value?: Partial<AtsConfig> }>("settings/ats")
      .then((s) => { if (s.value && (s.value.stages?.length || s.value.sources?.length)) setCfg({ ...DEFAULT_ATS_CONFIG, ...s.value }); })
      .catch(() => {});
  }, []);
  return cfg;
}

export default function Candidates({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<Candidate>("candidates");
  const { rows: apps } = useCollection<Application>("applications");
  const cfg = useAtsConfig();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<Candidate | "new" | null>(null);
  const [q, setQ] = useState("");
  const [uploading, setUploading] = useState<string | null>(null);
  const uploadFor = useRef<Candidate | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Where each candidate stands in hiring - the pool is useless if you can't tell who's in play.
  const pipeline = useMemo(() => {
    const stageLabel = new Map(cfg.stages.map((s) => [s.key, s.label]));
    const m = new Map<string, { active: string[]; hired: boolean }>();
    for (const a of apps) {
      if (!a.candidate) continue;
      const key = idOf(a.candidate);
      const e = m.get(key) ?? { active: [], hired: false };
      if (a.status === "hired") e.hired = true;
      else if (a.status === "active") e.active.push(stageLabel.get(a.stage) ?? a.stage);
      m.set(key, e);
    }
    return m;
  }, [apps, cfg]);

  const items = useMemo(() => {
    const sorted = [...rows].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""));
    const needle = q.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((c) =>
      [c.name, c.email, c.phone, c.tags, sourceLabel(c.source), c.source_detail].filter(Boolean).join(" ").toLowerCase().includes(needle),
    );
  }, [rows, q]);

  async function del(c: Candidate) {
    if (!(await confirm({ title: "Remove this candidate?", destructive: true, confirmLabel: "Remove" }))) return;
    try { await remove(`candidates/${idOf(c.path)}`); reload(); }
    catch (e) { toast({ title: "Couldn't remove", description: (e as Error).message, variant: "destructive" }); }
  }
  function pickResume(c: Candidate) { uploadFor.current = c; fileInput.current?.click(); }
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; const c = uploadFor.current;
    e.target.value = "";
    if (!f || !c) return;
    setUploading(c.path);
    try { await upload(`candidates/${idOf(c.path)}`, f); toast({ title: "Resume uploaded", variant: "success" }); reload(); }
    catch (err) { toast({ title: "Couldn't upload the resume", description: (err as Error).message, variant: "destructive" }); }
    finally { setUploading(null); }
  }

  useIntent("new-candidate", () => setDialog("new"));

  const newBtn = (
    <AccessAction collection="candidates" create label="Add a candidate">
      <Button onClick={() => setDialog("new")}><Plus className="h-4 w-4" /> Add candidate</Button>
    </AccessAction>
  );

  return (
    <div>
      <PageHeader title="Candidates" description="People in your talent pool." actions={<>{newBtn}<PageSettings me={me} host="candidates" /></>} />

      <input ref={fileInput} type="file" className="hidden" onChange={onFile} />

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length > 0 && (
          <SummaryStrip
            items={[
              { label: "In the pool", value: rows.length, icon: Users, tone: "primary" },
              { label: "With a resume", value: rows.filter((c) => c.has_resume).length, icon: FileText },
              { label: "From referrals", value: rows.filter((c) => c.source === "referral").length, icon: UserPlus, tone: "muted" },
            ]}
          />
        )}
        {rows.length > 0 && (
          <div className="relative mb-4 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, tag, source…" className="h-9 pl-8" />
          </div>
        )}
        {items.length === 0 ? (
          rows.length > 0 ? (
            <EmptyState illustration="noResults" icon={Search} title="No matches" description={`No candidate matches "${q.trim()}".`} />
          ) : (
            <EmptyState illustration="team" icon={Users} title="No candidates yet" description="Add people to your talent pool, then apply them to open jobs on the pipeline." action={newBtn} />
          )
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/40 text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Candidate</th>
                <th className="px-3 py-2 font-medium">Pipeline</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Tags</th>
                <th className="px-3 py-2 font-medium">Resume</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {items.map((c) => {
                  const can = c.access?.can ?? [];
                  return (
                    <tr key={c.path} className="border-b last:border-0 align-top">
                      <td className="px-3 py-2">
                        <button type="button" className="font-medium hover:underline" onClick={() => navigate(`candidates/${idOf(c.path)}`)}>{c.name}</button>
                        <div className="text-xs text-muted-foreground">{[c.email, c.phone].filter(Boolean).join(" · ")}</div>
                      </td>
                      <td className="px-3 py-2">
                        {(() => {
                          const p = pipeline.get(idOf(c.path));
                          if (p?.hired) return <Badge variant="success">Hired</Badge>;
                          if (p?.active.length) return <div className="flex flex-wrap gap-1">{p.active.map((s, i) => <Badge key={i} variant="outline">{s}</Badge>)}</div>;
                          return <span className="text-xs text-muted-foreground">Not in play</span>;
                        })()}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{sourceLabel(c.source)}{c.source_detail ? <div className="text-xs">{c.source_detail}</div> : null}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {(c.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          {c.has_resume && <AccessAction verb="download" objectPath={c.path} can={can} label="Download resume"><Button variant="ghost" size="sm" className="h-7" onClick={() => download(`candidates/${idOf(c.path)}`, `resume-${c.name}`)}><Download className="h-3.5 w-3.5" /> View</Button></AccessAction>}
                          {can.includes("upload") && <AccessAction verb="upload" objectPath={c.path} can={can} label="Attach resume"><Button variant="ghost" size="sm" className="h-7 text-muted-foreground" loading={uploading === c.path} onClick={() => pickResume(c)}><Paperclip className="h-3.5 w-3.5" /> {c.has_resume ? "Replace" : "Attach"}</Button></AccessAction>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {can.includes("update") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setDialog(c)} aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>}
                          {can.includes("delete") && <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => del(c)} aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>}
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
        <CandidateDialog
          candidate={dialog === "new" ? null : dialog}
          sources={cfg.sources}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload(); }}
        />
      )}
    </div>
  );
}

function CandidateDialog({ candidate, sources, onClose, onSaved }: {
  candidate: Candidate | null;
  sources: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const editing = !!candidate;
  const [name, setName] = useState(candidate?.name ?? "");
  const [email, setEmail] = useState(candidate?.email ?? "");
  const [phone, setPhone] = useState(candidate?.phone ?? "");
  const [source, setSource] = useState(candidate?.source ?? "");
  const [sourceDetail, setSourceDetail] = useState(candidate?.source_detail ?? "");
  const [tags, setTags] = useState(candidate?.tags ?? "");
  const [notes, setNotes] = useState(candidate?.notes ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const emailError = email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim()) ? "Doesn't look like an email address." : undefined;
  const valid = !!name.trim() && !emailError;

  async function save() {
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        source: source || null,
        source_detail: sourceDetail.trim() || null,
        tags: tags.trim() || null,
        notes: notes.trim() || null,
      };
      let path: string;
      if (editing) { await patch(`candidates/${idOf(candidate!.path)}`, body, candidate!.etag); path = candidate!.path; }
      else { const row = await create<Candidate>("candidates", body); path = row.path; }
      if (file) await upload(`candidates/${idOf(path)}`, file);
      toast({ title: editing ? "Updated" : "Candidate added", variant: "success" });
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
        <DialogHeader><DialogTitle>{editing ? "Edit candidate" : "Add a candidate"}</DialogTitle></DialogHeader>
        <FieldRow>
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
          <Field label="Email (optional)" error={emailError} info="Needed later if you hire them: accepting an offer creates their employee account from it.">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </FieldRow>
        <FieldRow>
          <Field label="Phone (optional)"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Source (optional)">
            <Select value={source || "none"} onValueChange={(v) => setSource(v === "none" ? "" : v)}>
              <SelectTrigger><SelectValue placeholder="Unknown" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unknown</SelectItem>
                {sources.map((s) => <SelectItem key={s} value={s}>{sourceLabel(s)}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </FieldRow>
        <Field label="Source detail (optional)" hint="Agency name, job-board URL, etc."><Input value={sourceDetail} onChange={(e) => setSourceDetail(e.target.value)} /></Field>
        <Field label="Tags (optional)" hint="Comma-separated."><Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="e.g. senior, backend, remote" /></Field>
        <Field label="Notes (optional)"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <Field label={candidate?.has_resume ? "Replace resume (optional)" : "Resume (optional)"}>
          <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} loading={busy} disabled={!valid}>{editing ? "Save" : "Add candidate"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
