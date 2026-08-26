import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Users, Plus, Pencil, Trash2, Paperclip, Download, Search, FileText, UserPlus } from "lucide-react";
import { create, patch, remove, upload, download, get } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { idOf } from "@/lib/utils";
import { isConflict } from "@/lib/formError";
import { parseContact } from "@/lib/ats";
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
import { useKpiFocus } from "@/lib/kpiFocus";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WriteDialog } from "@/components/common/WriteDialog";
import { FileDropField } from "@/components/common/FileDropField";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { getSetting } from "@/lib/settingsStore";

export const sourceLabel = (s?: string) => (s ? s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "");

export function useAtsConfig(): AtsConfig {
  const [cfg, setCfg] = useState<AtsConfig>(DEFAULT_ATS_CONFIG);
  useEffect(() => {
    getSetting<Partial<AtsConfig>>("ats")
      .then((s) => { if (s.value && (s.value.stages?.length || s.value.sources?.length)) setCfg({ ...DEFAULT_ATS_CONFIG, ...s.value }); })
      .catch(() => {});
  }, []);
  return cfg;
}

export default function Candidates({ me }: { me: Me }) {
  const { rows, state, error, reload } = useCollection<Candidate>("candidates");
  const cfg = useAtsConfig();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<Candidate | "new" | null>(null);
  // Applications put a "where are they in the pipeline" line on each candidate, and the dialog lists that
  // person's own applications - so an empty pool with no dialog open needs none of them.
  const { rows: apps } = useCollection<Application>("applications", { enabled: rows.length > 0 || dialog !== null });
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

  // A pool is only useful if you can see who is idle in it: a candidate nobody applied to a job, and one who
  // arrived this week, are the two the recruiter acts on. Each metric narrows the table to its own rows.
  const inPlay = (c: Candidate) => (pipeline.get(idOf(c.path))?.active.length ?? 0) > 0;
  const wasHired = (c: Candidate) => !!pipeline.get(idOf(c.path))?.hired;
  const notInPlay = (c: Candidate) => !inPlay(c) && !wasHired(c);
  const isNew = (c: Candidate) => (Date.now() - Date.parse(c.create_time ?? "")) / 86400000 <= 7;
  const kf = useKpiFocus<Candidate, "all" | "resume" | "noResume" | "referral" | "inPlay" | "notInPlay" | "hired" | "new">({
    all: { label: "candidates", match: () => true },
    resume: { label: "candidates with a resume", match: (c) => !!c.has_resume },
    noResume: { label: "candidates missing a resume", match: (c) => !c.has_resume },
    referral: { label: "referred candidates", match: (c) => c.source === "referral" },
    inPlay: { label: "candidates in play", match: inPlay },
    notInPlay: { label: "candidates not in play", match: notInPlay },
    hired: { label: "hired candidates", match: wasHired },
    new: { label: "candidates added this week", match: isNew },
  });

  const items = useMemo(() => {
    const sorted = [...rows].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""));
    const needle = q.trim().toLowerCase();
    const matched = !needle
      ? sorted
      : sorted.filter((c) =>
          [c.name, c.email, c.phone, c.tags, sourceLabel(c.source), c.source_detail].filter(Boolean).join(" ").toLowerCase().includes(needle),
        );
    return kf.apply(matched);
  }, [rows, q, kf.focus]); // eslint-disable-line react-hooks/exhaustive-deps

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
              { label: "In the pool", value: rows.length, icon: Users, tone: "primary", hint: "everyone on file", onClick: () => kf.setFocus(null), active: kf.focus === null },
              { label: "In play", value: rows.filter(inPlay).length, icon: Users, tone: rows.some(inPlay) ? "primary" : "muted", hint: "on an application", ...kf.kpi("inPlay") },
              { label: "Not in play", value: rows.filter(notInPlay).length, tone: rows.some(notInPlay) ? "warning" : "muted", hint: "never applied", ...kf.kpi("notInPlay") },
              ...(rows.some(isNew) ? [{ label: "Added this week", value: rows.filter(isNew).length, icon: UserPlus, tone: "primary" as const, hint: "new to the pool", ...kf.kpi("new") }] : []),
              { label: "No resume", value: rows.filter((c) => !c.has_resume).length, icon: FileText, tone: rows.some((c) => !c.has_resume) ? "warning" : "success", hint: "nothing to screen", ...kf.kpi("noResume") },
              { label: "From referrals", value: rows.filter((c) => c.source === "referral").length, icon: UserPlus, tone: "muted", hint: "sourced by staff", ...kf.kpi("referral") },
            ]}
          />
        )}
        {rows.length > 0 && (
          <div className="relative mb-4 max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, tag, source…" className="h-9 pl-8" />
          </div>
        )}
        {items.length === 0 ? (
          kf.activeLabel ? (
            <EmptyState illustration="noResults" icon={Search} title={`No ${kf.activeLabel}`} description="Nothing in the pool matches that metric right now." action={<Button variant="outline" onClick={kf.clear}>Show the whole pool</Button>} />
          ) : rows.length > 0 ? (
            <EmptyState illustration="noResults" icon={Search} title="No matches" description={`No candidate matches "${q.trim()}".`} />
          ) : (
            <EmptyState illustration="team" icon={Users} title="No candidates yet" description="Add people to your talent pool, then apply them to open jobs on the pipeline." action={newBtn} />
          )
        ) : (
          <div className="scroll-shadow-x overflow-x-auto rounded-lg border">
            {/* Six columns: labelled blocks below `sm`, a table from there up (`.table-stack`). */}
            <table className="table-stack w-full text-sm">
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
                      <td data-label="Pipeline" className="px-3 py-2">
                        {(() => {
                          const p = pipeline.get(idOf(c.path));
                          if (p?.hired) return <Badge variant="success">Hired</Badge>;
                          if (p?.active.length) return <div className="flex flex-wrap gap-1">{p.active.map((s, i) => <Badge key={i} variant="outline">{s}</Badge>)}</div>;
                          return <span className="text-xs text-muted-foreground">Not in play</span>;
                        })()}
                      </td>
                      <td data-label="Source" className="px-3 py-2 text-muted-foreground"><span className="inline-block text-right sm:text-left">{sourceLabel(c.source)}{c.source_detail ? <span className="block text-xs">{c.source_detail}</span> : null}</span></td>
                      <td data-label="Tags" className="px-3 py-2">
                        <div className="flex flex-wrap justify-end gap-1 sm:justify-start">
                          {(c.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
                        </div>
                      </td>
                      <td data-label="Resume" className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1 sm:justify-start">
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
          pool={rows}
          apps={apps}
          stageLabel={(key) => cfg.stages.find((s) => s.key === key)?.label ?? key}
          sources={cfg.sources}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); reload(); }}
        />
      )}
    </div>
  );
}

// What "source detail" means depends on the source: an agency wants a name, a board wants the posting link.
const SOURCE_DETAIL: Record<string, { label: string; hint: string }> = {
  referral: { label: "Who referred them", hint: "The employee who passed the name on." },
  agency: { label: "Agency", hint: "Which agency sent them, so an invoice can be matched to a hire." },
  job_board: { label: "Job board / posting link", hint: "Where the application came in from." },
  linkedin: { label: "Profile link", hint: "The profile you sourced them from." },
  career_site: { label: "Which posting", hint: "The role on the site they applied to." },
  direct: { label: "How they reached you", hint: "An email in, a conference, a cold approach." },
};

const EMPTY_CANDIDATE = { name: "", email: "", phone: "", source: "", source_detail: "", tags: "", notes: "" };

function CandidateDialog({ candidate, pool, apps, stageLabel, sources, onClose, onSaved }: {
  candidate: Candidate | null;
  /** The whole pool, for the already-on-file guard and the tag vocabulary. */
  pool: Candidate[];
  apps: Application[];
  stageLabel: (key: string) => string;
  sources: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const editing = !!candidate;
  const [form, setForm] = useState(() => (candidate
    ? {
        name: candidate.name ?? "",
        email: candidate.email ?? "",
        phone: candidate.phone ?? "",
        source: candidate.source ?? "",
        source_detail: candidate.source_detail ?? "",
        tags: candidate.tags ?? "",
        notes: candidate.notes ?? "",
      }
    : EMPTY_CANDIDATE));
  const [file, setFile] = useState<File | null>(null);
  // The version an edit writes against, refreshed from the server when a save loses a race.
  const [etag, setEtag] = useState(candidate?.etag);
  const emailError = form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim()) ? "Doesn't look like an email address." : undefined;
  const canSubmit = !!form.name.trim() && !emailError;

  // The same person entered twice is how a talent pool rots: two rows, two histories, one of them stale. Email
  // first (it is the identity the rest of hiring uses), then phone, then an exact name match.
  const twin = useMemo(() => {
    const email = form.email.trim().toLowerCase();
    const phone = form.phone.replace(/\D/g, "");
    const name = form.name.trim().toLowerCase();
    const others = pool.filter((c) => c.path !== candidate?.path);
    return (
      (email ? others.find((c) => (c.email ?? "").trim().toLowerCase() === email) : undefined)
      ?? (phone.length >= 7 ? others.find((c) => (c.phone ?? "").replace(/\D/g, "") === phone) : undefined)
      ?? (name ? others.find((c) => (c.name ?? "").trim().toLowerCase() === name) : undefined)
      ?? null
    );
  }, [pool, form.email, form.phone, form.name, candidate?.path]);
  // Where that duplicate stands, so the warning is a decision rather than a nag.
  const twinStanding = useMemo(() => {
    if (!twin) return "";
    const theirs = apps.filter((a) => a.candidate && idOf(a.candidate) === idOf(twin.path));
    if (theirs.some((a) => a.status === "hired")) return "already hired";
    const live = theirs.filter((a) => a.status === "active");
    if (live.length) return `in ${live.map((a) => stageLabel(a.stage)).join(", ")}`;
    return theirs.length ? "closed applications only" : "never applied to anything";
  }, [twin, apps, stageLabel]);

  // Tags already in use, so the pool converges on one vocabulary instead of "backend", "back-end", "Backend".
  const chosen = form.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const tagSuggestions = useMemo(() => {
    const count = new Map<string, number>();
    for (const c of pool) {
      for (const raw of (c.tags ?? "").split(",")) {
        const t = raw.trim();
        if (t) count.set(t, (count.get(t) ?? 0) + 1);
      }
    }
    return [...count.entries()]
      .filter(([t]) => !chosen.includes(t.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t]) => t);
  }, [pool, form.tags]); // eslint-disable-line react-hooks/exhaustive-deps
  const addTag = (t: string) => setForm({ ...form, tags: form.tags.trim() ? `${form.tags.replace(/,\s*$/, "")}, ${t}` : t });

  const detail = SOURCE_DETAIL[form.source] ?? { label: "Source detail (optional)", hint: "Agency name, job-board URL, whoever passed the name on." };

  // Paste-to-fill: what was pasted, and what it managed to read out of it.
  const [paste, setPaste] = useState("");
  const [pasted, setPasted] = useState("");
  function applyPaste(text: string) {
    const found = parseContact(text);
    const filled: string[] = [];
    setForm((f) => {
      const next = { ...f };
      // Only ever fills a blank field: a paste must not quietly overwrite something already typed.
      if (found.name && !next.name.trim()) { next.name = found.name; filled.push("name"); }
      if (found.email && !next.email.trim()) { next.email = found.email; filled.push("email"); }
      if (found.phone && !next.phone.trim()) { next.phone = found.phone; filled.push("phone"); }
      return next;
    });
    setPasted(filled.length ? `Filled the ${filled.join(", ")} - check it before saving.` : "Nothing recognisable in that; fill the fields below by hand.");
  }

  async function submit() {
    const body = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      source: form.source || null,
      source_detail: form.source_detail.trim() || null,
      tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean).join(", ") || null,
      notes: form.notes.trim() || null,
    };
    let path: string;
    if (editing) {
      try {
        await patch(`candidates/${idOf(candidate!.path)}`, body, etag ?? candidate!.etag);
      } catch (e) {
        // Lost race: a recruiter retagged them while this form was open. Take their etag, so the next press is
        // a deliberate overwrite instead of an "etag mismatch" nobody can act on.
        if (isConflict(e)) {
          const fresh = await get<Candidate>(`candidates/${idOf(candidate!.path)}`).catch(() => null);
          if (fresh) setEtag(fresh.etag);
          throw new Error("Somebody else changed this candidate while you had it open. Press Save again to keep your version.");
        }
        throw e;
      }
      path = candidate!.path;
    } else {
      const row = await create<Candidate>("candidates", body);
      path = row.path;
    }
    if (file) await upload(`candidates/${idOf(path)}`, file);
    toast({ title: editing ? "Candidate updated" : "Candidate added", variant: "success" });
    onSaved();
  }

  return (
    <WriteDialog
      open
      onClose={onClose}
      title={editing ? "Edit candidate" : "Add a candidate"}
      description="The pool is who you know; applying them to a job is what puts them on the pipeline. If they're hired, their employee account is created from the email here."
      collection="candidates"
      objectPath={candidate?.path}
      guardLabel="candidate"
      form={{ ...form, resume: file ? `${file.name}:${file.size}` : null }}
      draftKey={editing ? undefined : "candidate:new"}
      applyDraft={editing ? undefined : (d) => setForm({ name: d.name, email: d.email, phone: d.phone, source: d.source, source_detail: d.source_detail, tags: d.tags, notes: d.notes })}
      onStartOver={editing ? undefined : () => { setForm(EMPTY_CANDIDATE); setFile(null); }}
      submitLabel={editing ? "Save changes" : "Add candidate"}
      canSubmit={canSubmit}
      whyNot={[!form.name.trim() && "Give the candidate a name.", !!emailError && "Fix the email address."]}
      onSubmit={submit}
      // Sourcing happens in runs - a board export, an agency's five names - so the source carries over and the
      // person doesn't.
      addAnother={editing ? undefined : () => { setForm({ ...EMPTY_CANDIDATE, source: form.source, source_detail: form.source_detail }); setFile(null); }}
    >
      {/* Most candidates arrive as a block of text: an email signature, a profile blurb pasted into chat. The
          text already holds the name, the email and the phone, so paste it once instead of retyping three
          fields off it. Everything it fills stays editable - a guess presented as a fact is worse than none. */}
      {!editing && (
        <Field
          label="Paste a signature or blurb (optional)"
          hint={pasted ? pasted : "Anything with their details in it. Nothing is saved from this box - it only fills the fields below."}
          action={paste.trim() ? <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => { setPaste(""); setPasted(""); }}>Clear</Button> : undefined}
        >
          <Textarea
            rows={2}
            value={paste}
            placeholder={"Asha Rao\nasha.rao@example.com · +91 98xxx xxxxx"}
            onChange={(e) => setPaste(e.target.value)}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (!text.trim()) return;
              e.preventDefault();
              setPaste(text);
              applyPaste(text);
            }}
            onBlur={() => paste.trim() && applyPaste(paste)}
          />
        </Field>
      )}
      <FieldRow>
        <Field label="Name" field="name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
        <Field label="Email (optional)" field="email" error={emailError} info="Needed later if you hire them: accepting an offer creates their employee account from it.">
          <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
      </FieldRow>
      {twin && (
        <div className="-mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{twin.name} is already in the pool ({twinStanding}). A second row splits their history - edit the one you have instead.</span>
          {/* Safe to walk away from: a new candidate's form is kept as a draft and comes back when you return. */}
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => navigate(`candidates/${idOf(twin.path)}`)}>Open their profile</Button>
        </div>
      )}
      <FieldRow>
        <Field label="Phone (optional)" field="phone"><Input type="tel" inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        <Field label="Source (optional)" field="source" hint="Where they came from, so sourcing can be measured.">
          <Select value={form.source || "none"} onValueChange={(v) => setForm({ ...form, source: v === "none" ? "" : v })}>
            <SelectTrigger><SelectValue placeholder="Unknown" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Unknown</SelectItem>
              {sources.map((s) => <SelectItem key={s} value={s}>{sourceLabel(s)}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </FieldRow>
      <Field label={detail.label} field="source_detail" hint={detail.hint}>
        <Input value={form.source_detail} onChange={(e) => setForm({ ...form, source_detail: e.target.value })} />
      </Field>
      <Field label="Tags (optional)" field="tags" hint="Comma-separated. Tags are how the pool gets searched months later.">
        <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="e.g. senior, backend, remote" />
        {tagSuggestions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Already in use:</span>
            {tagSuggestions.map((t) => (
              <button key={t} type="button" onClick={() => addTag(t)} className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                + {t}
              </button>
            ))}
          </div>
        )}
      </Field>
      <Field label="Notes (optional)" field="notes"><Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="What they've done, what they're after…" /></Field>
      <Field
        label={candidate?.has_resume ? "Replace resume (optional)" : "Resume (optional)"}
        hint={candidate?.has_resume ? "Uploading replaces the resume on file." : "A candidate with nothing to screen stalls in the pool."}
      >
        <FileDropField file={file} onFile={setFile} accept=".pdf,.doc,.docx,application/pdf" hint="PDF or Word" />
      </Field>
    </WriteDialog>
  );
}
