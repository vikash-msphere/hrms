import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import {
  FileText, Plus, Trash2, Download, Upload, RotateCcw, ShieldX, ShieldPlus, ScrollText, FileBadge, FileLock, File, History,
  FileImage, FileSpreadsheet, FileArchive, FileVideo, FileAudio, Pencil, Building2, UserRound,
  Lock, Unlock, Send, FileEdit, CheckCircle2, Ban, FileSignature, Sparkles, PenLine, ClipboardCheck, AlertCircle,
  RefreshCw, ExternalLink, ShieldCheck, Loader2,
} from "lucide-react";
import { api, upload, patch, invoke, download as downloadFile } from "@/api";
import { useDocuments, createDocument, docCollection, documentFileName } from "@/lib/documents";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission, useCapabilities, canSeeActivity } from "@/lib/perm";
import { useLetterTemplates, groupByCategory } from "@/lib/letterTemplates";
import { LetterInputFields, missingRequiredInputs } from "@/components/common/LetterInputFields";
import { cn, formatDate, humanize, idOf } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { RupeeCircle } from "@/components/icons/RupeeCircle";
import { navigate } from "@/router";
import { SignatureImage } from "@/components/common/SignatureField";
import { PdfSignaturePlacer } from "@/components/common/PdfSignaturePlacer";
// Lazy so the signature verifier (PKI.js) + pdf.js only load when a signature is actually viewed.
const SignedPdfViewer = lazy(() => import("@/components/common/SignedPdfViewer").then((m) => ({ default: m.SignedPdfViewer })));
import type { DocumentResource, DocumentAcknowledgement, Employee, Department, Me, SignBox } from "@/types";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { DataTable, type Column } from "@/components/common/DataTable";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { ActivityFeed } from "@/components/common/ActivityFeed";
import { Field } from "@/components/common/Field";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const TYPES = ["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "INSURANCE", "OTHER"];
const TYPE_ICON: Record<string, typeof File> = { CONTRACT: ScrollText, ID: FileBadge, PAYSLIP: RupeeCircle, POLICY: FileLock, LETTER: FileSignature, INSURANCE: ShieldPlus, OTHER: File };
// Local calendar date - toISOString() would call a doc that expires today "valid" until UTC catches up.
const pad2 = (n: number) => String(n).padStart(2, "0");
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

const ORG = "__org__"; // sentinel: not tied to an employee = organization-wide

// Icon + colour reflecting the actual file type (by extension, then MIME).
const EXT_ICON: Record<string, { icon: typeof File; tint: string }> = {
  pdf: { icon: FileText, tint: "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-400" },
  doc: { icon: FileText, tint: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400" },
  docx: { icon: FileText, tint: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400" },
  odt: { icon: FileText, tint: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400" },
  rtf: { icon: FileText, tint: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400" },
  pages: { icon: FileText, tint: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400" },
  txt: { icon: FileText, tint: "bg-brand-neutral-100 text-brand-neutral-600 dark:bg-brand-neutral-500/20 dark:text-brand-neutral-300" },
  md: { icon: FileText, tint: "bg-brand-neutral-100 text-brand-neutral-600 dark:bg-brand-neutral-500/20 dark:text-brand-neutral-300" },
  ppt: { icon: FileText, tint: "bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400" },
  pptx: { icon: FileText, tint: "bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400" },
  odp: { icon: FileText, tint: "bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400" },
  csv: { icon: FileSpreadsheet, tint: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400" },
  xls: { icon: FileSpreadsheet, tint: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400" },
  xlsx: { icon: FileSpreadsheet, tint: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400" },
  ods: { icon: FileSpreadsheet, tint: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400" },
  numbers: { icon: FileSpreadsheet, tint: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400" },
  png: { icon: FileImage, tint: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400" },
  jpg: { icon: FileImage, tint: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400" },
  jpeg: { icon: FileImage, tint: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400" },
  gif: { icon: FileImage, tint: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400" },
  webp: { icon: FileImage, tint: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400" },
  svg: { icon: FileImage, tint: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400" },
  heic: { icon: FileImage, tint: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400" },
};

const MIME_PREFIX_ICON: { test: (ct: string) => boolean; entry: { icon: typeof File; tint: string } }[] = [
  { test: (ct) => ct.startsWith("image/"), entry: { icon: FileImage, tint: "bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400" } },
  { test: (ct) => ct.startsWith("video/"), entry: { icon: FileVideo, tint: "bg-pink-50 text-pink-600 dark:bg-pink-500/15 dark:text-pink-400" } },
  { test: (ct) => ct.startsWith("audio/"), entry: { icon: FileAudio, tint: "bg-fuchsia-50 text-fuchsia-600 dark:bg-fuchsia-500/15 dark:text-fuchsia-400" } },
  { test: (ct) => ct === "application/pdf", entry: { icon: FileText, tint: "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-400" } },
  { test: (ct) => ct.includes("zip") || ct.includes("compressed"), entry: { icon: FileArchive, tint: "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400" } },
  { test: (ct) => ct.includes("sheet") || ct.includes("excel") || ct.includes("spreadsheet"), entry: { icon: FileSpreadsheet, tint: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400" } },
  { test: (ct) => ct.includes("presentation") || ct.includes("powerpoint"), entry: { icon: FileText, tint: "bg-orange-50 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400" } },
  { test: (ct) => ct.includes("word") || ct.includes("opendocument") || ct.includes("msword"), entry: { icon: FileText, tint: "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400" } },
];

function fileIcon(d: DocumentResource): { icon: typeof File; tint: string } {
  const ext = d.file_name?.split(".").pop()?.toLowerCase();
  if (ext && EXT_ICON[ext]) return EXT_ICON[ext];
  const ct = d.content_type?.toLowerCase();
  if (ct) {
    const m = MIME_PREFIX_ICON.find((x) => x.test(ct));
    if (m) return m.entry;
  }
  if (d.size_bytes) return { icon: File, tint: "bg-accent text-accent-foreground" };
  // No file uploaded yet - fall back to the document category icon.
  return { icon: TYPE_ICON[d.document_type] ?? File, tint: "bg-accent text-accent-foreground" };
}

function formatBytes(n?: number) {
  if (!n) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");

// Policies that require acknowledgement must be PDFs: each signature files the policy with a certificate page
// appended (PDF-only merge). The server is authoritative; these mirror it for picker `accept` + early errors.
const isPdfFile = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isPdfDoc = (d: DocumentResource) => d.content_type === "application/pdf" || /\.pdf$/i.test(d.file_name ?? "");

// Accepted upload types for the file picker - derived from the icon map so the two
// stay in sync. Add or remove an extension in EXT_ICON and the picker follows.
const ACCEPT = Object.keys(EXT_ICON)
  .map((e) => `.${e}`)
  .join(",");

type Mode = { kind: "create" } | { kind: "edit"; doc: DocumentResource };
const EMPTY = { name: "", type: "OTHER", expire: "", employee: ORG, requireAck: false, ackMethod: "internal" as "internal" | "cashfree", signAnchor: null as SignBox | null, published: true, audience: "none" as "none" | "everyone" | "specific", audienceEmployees: [] as string[] };

export default function Documents({ me }: { me: Me }) {
  const { rows, state, error, reload } = useDocuments({ showDeleted: true });
  const { rows: employees } = useCollection<Employee>("employees");
  const { rows: departments } = useCollection<Department>("departments");
  const [pickAudience, setPickAudience] = useState(false);
  // The acknowledging user's own record (for their signature image + name on the acknowledge dialog).
  const myEmp = useMemo(() => employees.find((e) => idOf(e.path) === me.employee_id), [employees, me.employee_id]);
  const myName = myEmp ? `${myEmp.first_name} ${myEmp.last_name}` : "";
  // The name that will appear on the signature/certificate: the legal name on file, else the display name.
  const myLegalName = myEmp ? (myEmp.legal_name || myName) : "";
  const { toast } = useToast();
  // Per-resource soft-delete/lifecycle flows; the right one is picked per row by ownership (org vs personal).
  const sdOrg = useSoftDelete("org-documents", "document", reload);
  const sdPersonal = useSoftDelete("personal-documents", "document", reload);
  const lcOrg = useLifecycle("org-documents", "document", reload);
  const lcPersonal = useLifecycle("personal-documents", "document", reload);
  const sd = (d: DocumentResource) => (docCollection(d) === "personal-documents" ? sdPersonal : sdOrg);
  const lc = (d: DocumentResource) => (docCollection(d) === "personal-documents" ? lcPersonal : lcOrg);

  const writable = usePermission("org-documents.write") || usePermission("personal-documents.write");
  const canPurge = usePermission("org-documents.admin") || usePermission("personal-documents.admin");
  const caps = useCapabilities(); // for per-document activity gating (a doc may be org- or personal-scoped)
  // Letter generation is HR + super only (personal-documents.write distinguishes them from employees, who
  // hold only read on their own docs). The server enforces the real gate (personal-documents.generateLetter).
  const canGenerate = usePermission("personal-documents.write");
  const letterTemplates = useLetterTemplates();

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    return (p?: string) => (p ? m.get(idOf(p)) ?? idOf(p) : "");
  }, [employees]);

  const [dialog, setDialog] = useState<Mode | null>(null);
  const [form, setForm] = useState(EMPTY);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  // Acknowledgement: the doc an employee is signing, and (HR) the doc whose progress is open.
  const [ackDoc, setAckDoc] = useState<DocumentResource | null>(null);
  // E-signature (letters/contracts): the owner signs their own generated letter in place.
  const [signDoc, setSignDoc] = useState<DocumentResource | null>(null);
  const [activityDoc, setActivityDoc] = useState<DocumentResource | null>(null);
  const isMine = (d: DocumentResource) => !!d.employee && idOf(d.employee) === me.employee_id;
  const [progressDoc, setProgressDoc] = useState<DocumentResource | null>(null);
  // In-app signature viewer: the doc being inspected + its bytes fetched client-side (server unchanged).
  const [viewerDoc, setViewerDoc] = useState<DocumentResource | null>(null);
  const [viewerBytes, setViewerBytes] = useState<Uint8Array | null>(null);

  // Whoever manages policies (HR/super: org-documents write) gets the policy-centric view; everyone else
  // (employees) gets the signed-copy-centric view. The pairing of a signed copy to its source policy comes
  // straight off the personal-document's `source_document` (readable by all), NOT the acknowledgement records
  // (which are super-only by default), so it works for every role without a grant change.
  const managesPolicies = usePermission("org-documents.write");
  const originalByPath = useMemo(
    () => new Map(rows.filter((d) => docCollection(d) === "org-documents").map((d) => [d.path, d])),
    [rows],
  );

  // Signed copies are filed as personal-documents and would otherwise clutter the list as their own rows.
  // HR: nest each signed copy under its source policy (foldable). Employee: show the signed copy as the
  // primary row and hide the original policy once they've signed the current version (it moves to the row's
  // "Download original" action). Only group when the source policy is visible to the caller.
  const { topRows, childrenByPath } = useMemo(() => {
    const childrenBySource = new Map<string, DocumentResource[]>();
    const signedCopyPaths = new Set<string>();
    for (const d of rows) {
      if (d.source_document && originalByPath.has(d.source_document)) {
        signedCopyPaths.add(d.path);
        const list = childrenBySource.get(d.source_document) ?? [];
        list.push(d);
        childrenBySource.set(d.source_document, list);
      }
    }
    for (const list of childrenBySource.values()) list.sort((x, y) => (y.create_time ?? "").localeCompare(x.create_time ?? ""));

    if (managesPolicies) {
      return { topRows: rows.filter((d) => !signedCopyPaths.has(d.path)), childrenByPath: childrenBySource };
    }
    // Employee: collapse a signed policy to its signed copy by hiding the original (only once the current
    // version is acknowledged - if a re-acknowledgement is due the original stays visible to act on).
    const hideOriginal = new Set<string>();
    for (const src of childrenBySource.keys()) {
      if (originalByPath.get(src)?.acknowledged) hideOriginal.add(src);
    }
    return { topRows: rows.filter((d) => !hideOriginal.has(d.path)), childrenByPath: new Map<string, DocumentResource[]>() };
  }, [rows, originalByPath, managesPolicies]);

  // Generate-letter dialog state.
  const [genOpen, setGenOpen] = useState(false);
  const [genEmployee, setGenEmployee] = useState("");
  const [genType, setGenType] = useState("");
  // Per-generation e-sign choice: null = follow the template (its e-signature block); true/false overrides it.
  const [genEsign, setGenEsign] = useState<boolean | null>(null);
  const [genInputs, setGenInputs] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const genTemplate = letterTemplates.find((t) => t.path === genType);

  // Hidden input used by the per-row "Replace file" action.
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<DocumentResource | null>(null);

  function openCreate() {
    setForm(EMPTY);
    setFile(null);
    setDialog({ kind: "create" });
  }
  useIntent("new-document", openCreate);
  function openEdit(d: DocumentResource) {
    setForm({
      name: d.display_name,
      type: d.document_type,
      expire: d.expire_time ? d.expire_time.slice(0, 10) : "",
      employee: d.employee ? `employees/${idOf(d.employee)}` : ORG,
      requireAck: !!d.requires_ack,
      ackMethod: d.ack_method ?? "internal",
      signAnchor: d.sign_anchor ?? null,
      published: d.published !== false,
      audience: "none",
      audienceEmployees: [],
    });
    setFile(null);
    setDialog({ kind: "edit", doc: d });
  }

  function onPickFile(f: File | null) {
    setFile(f);
    // Acknowledgement is PDF-only; picking a non-PDF (or clearing the file) disables + unchecks it.
    setForm((s) => ({
      ...s,
      name: f && !s.name.trim() ? stripExt(f.name) : s.name,
      requireAck: f && isPdfFile(f) ? s.requireAck : false,
    }));
  }

  function bodyFromForm() {
    return {
      display_name: form.name,
      document_type: form.type,
      employee: form.employee === ORG ? null : form.employee,
      expire_time: form.expire || null,
      // Acknowledgement applies to org-wide documents of any type; the server ignores it on personal docs.
      requires_ack: form.employee === ORG ? form.requireAck : false,
      // Ack signing method + signature-box placement (required together with requires_ack, server-enforced).
      ack_method: form.employee === ORG && form.requireAck ? form.ackMethod : undefined,
      sign_anchor: form.employee === ORG && form.requireAck ? form.signAnchor : undefined,
      // Who to notify on publish (org docs only). The server only acts on create; if requires_ack, the
      // notification is an action item ("review & sign").
      notify_audience:
        form.employee === ORG
          ? form.audience === "everyone"
            ? { kind: "everyone" as const }
            : form.audience === "specific"
              ? { kind: "employees" as const, employees: form.audienceEmployees }
              : { kind: "none" as const }
          : { kind: "none" as const },
    };
  }

  async function submit() {
    if (!dialog) return;
    const body = bodyFromForm();
    // A document that requires acknowledgement must be a PDF (the signature is stamped in place onto it).
    if (body.requires_ack) {
      if (dialog.kind === "create" && file && !isPdfFile(file)) {
        toast({ title: "Acknowledgement needs a PDF", description: "Choose a PDF file, or turn off Require acknowledgement.", variant: "destructive" });
        return;
      }
      if (dialog.kind === "edit" && dialog.doc.size_bytes && !isPdfDoc(dialog.doc)) {
        toast({ title: "Acknowledgement needs a PDF", description: "Replace the file with a PDF before requiring acknowledgement.", variant: "destructive" });
        return;
      }
      // The signature box is mandatory: HR must place it on the rendered PDF.
      if (!form.signAnchor) {
        toast({ title: "Place the signature", description: "Click on the document to position the signature box before saving.", variant: "destructive" });
        return;
      }
    }
    setBusy(true);
    try {
      if (dialog.kind === "create") {
        const doc = await createDocument({ ...body, published: form.published });
        if (file) await upload(doc.path, file);
        toast({ title: file ? "Document uploaded" : "Document added", variant: "success" });
      } else {
        await patch(dialog.doc.path, body, dialog.doc.etag);
        toast({ title: "Document updated", variant: "success" });
      }
      setDialog(null);
      reload();
    } catch (e) {
      toast({ title: "Couldn't save document", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!genEmployee) return;
    setGenerating(true);
    try {
      const doc = await api<DocumentResource>("/personal-documents:generateLetter", {
        method: "POST",
        body: JSON.stringify({ employee: genEmployee, letter_type: genType, ...(genTemplate?.inputs?.length ? { input: genInputs } : {}), ...(genEsign !== null ? { esign: genEsign } : {}) }),
      });
      toast({ title: "Letter generated", description: doc.display_name, variant: "success" });
      setGenOpen(false);
      reload();
      // Offer the freshly-rendered PDF straight away.
      try { await downloadFile(doc.path, documentFileName({ ...doc, content_type: doc.content_type ?? "application/pdf" })); } catch { /* it's in the list to download */ }
    } catch (e) {
      toast({ title: "Couldn't generate letter", description: (e as Error).message, variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  }

  function openGenerate() {
    setGenEmployee("");
    setGenType(letterTemplates[0]?.path ?? "");
    setGenEsign(null);
    setGenInputs({});
    setGenOpen(true);
  }

  function triggerReplace(d: DocumentResource) {
    replaceTarget.current = d;
    replaceInput.current?.click();
  }

  async function onReplaceFile(f: File | null) {
    const d = replaceTarget.current;
    if (!f || !d) return;
    if (d.requires_ack && !isPdfFile(f)) {
      toast({ title: "Policies must be PDFs", description: "A policy requiring acknowledgement can only be replaced with a PDF.", variant: "destructive" });
      replaceTarget.current = null;
      if (replaceInput.current) replaceInput.current.value = "";
      return;
    }
    try {
      await upload(d.path, f);
      toast({ title: "File uploaded", variant: "success" });
      reload();
    } catch (e) {
      toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      replaceTarget.current = null;
      if (replaceInput.current) replaceInput.current.value = "";
    }
  }

  async function doSign() {
    if (!signDoc) return;
    setBusy(true);
    try {
      await invoke(signDoc.path, "sign");
      toast({ title: "Signed", description: signDoc.display_name, variant: "success" });
      setSignDoc(null);
      reload();
    } catch (e) {
      toast({ title: "Couldn't sign", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function doAcknowledge() {
    if (!ackDoc) return;
    setBusy(true);
    try {
      const res = await invoke<DocumentResource>(ackDoc.path, "acknowledge");
      if (res.esign_url) {
        // Aadhaar (Cashfree): the ack is pending until the employee completes the signing journey. Open it.
        window.open(res.esign_url, "_blank", "noopener");
        toast({ title: "Complete your Aadhaar e-sign", description: "Finish signing in the new tab; this document updates once done.", variant: "success" });
      } else {
        toast({ title: "Acknowledged", description: ackDoc.display_name, variant: "success" });
      }
      setAckDoc(null);
      reload(); // the new signed copy + acknowledged state come back on reload
    } catch (e) {
      toast({ title: "Couldn't acknowledge", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function onDownload(d: DocumentResource) {
    try {
      await downloadFile(d.path, documentFileName(d));
    } catch (e) {
      toast({ title: "Download failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  const today = todayStr();
  // Expiry tracking: a doc is "Expiring soon" within 30 days of its expire_time, "Expired" once past.
  const soonCutoff = (() => { const d = new Date(Date.now() + 30 * 86400000); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; })();
  const expiryBucket = (d: DocumentResource): "" | "Expired" | "Expiring soon" | "Valid" => {
    if (!d.expire_time) return "";
    const day = d.expire_time.slice(0, 10);
    if (day < today) return "Expired";
    if (day <= soonCutoff) return "Expiring soon";
    return "Valid";
  };
  const expiryStats = useMemo(() => {
    let expired = 0, soon = 0;
    for (const d of rows) {
      if (d.delete_time) continue;
      const b = d.expire_time ? (d.expire_time.slice(0, 10) < today ? "Expired" : d.expire_time.slice(0, 10) <= soonCutoff ? "Expiring soon" : "Valid") : "";
      if (b === "Expired") expired++;
      else if (b === "Expiring soon") soon++;
    }
    return { expired, soon };
  }, [rows, today, soonCutoff]);
  const columns: Column<DocumentResource>[] = [
    {
      id: "title",
      header: "Title",
      accessor: (d) => d.display_name,
      cell: (d) => {
        const { icon: Icon, tint } = fileIcon(d);
        return (
          <div className="flex items-center gap-3">
            <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${tint}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <span className="font-medium">{d.display_name}</span>
              {d.file_name && <div className="truncate text-xs text-muted-foreground">{d.file_name}</div>}
            </div>
          </div>
        );
      },
    },
    { id: "type", header: "Type", filter: "select", accessor: (d) => humanize(d.document_type), cell: (d) => <Badge variant="secondary">{humanize(d.document_type)}</Badge> },
    {
      id: "owner",
      header: "Belongs to",
      filter: "select",
      accessor: (d) => (d.employee ? empName(d.employee) : "Organization"),
      cell: (d) =>
        d.employee ? (
          <span className="inline-flex items-center gap-1.5"><UserRound className="h-3.5 w-3.5 text-muted-foreground" /> {empName(d.employee)}</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Building2 className="h-3.5 w-3.5" /> Organization</span>
        ),
    },
    {
      id: "file",
      header: "File",
      accessor: (d) => (d.size_bytes ? "Uploaded" : "Missing"),
      cell: (d) =>
        d.size_bytes ? (
          <span className="text-muted-foreground">{formatBytes(d.size_bytes)}</span>
        ) : (
          <Badge variant="warning">No file</Badge>
        ),
    },
    {
      id: "expires",
      header: "Expiry",
      // Filter/group by status (expired / expiring soon / valid); the date is shown in the cell.
      filter: "select",
      accessor: (d) => expiryBucket(d),
      cell: (d) => {
        if (!d.expire_time) return <span className="text-muted-foreground">-</span>;
        const b = expiryBucket(d);
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className={b === "Expired" ? "text-destructive" : "text-muted-foreground"}>{formatDate(d.expire_time)}</span>
            {b === "Expired" && <Badge variant="destructive">Expired</Badge>}
            {b === "Expiring soon" && <Badge variant="warning">Soon</Badge>}
          </span>
        );
      },
    },
    {
      id: "compliance",
      header: "Acknowledgement",
      filter: "select",
      accessor: (d) =>
        d.requires_ack ? (d.acknowledged ? "Acknowledged" : "Action required")
        : d.requires_signature ? (d.signed_time ? "Signed" : "Awaiting signature")
        : "",
      cell: (d) =>
        d.requires_ack ? (
          d.acknowledged ? (
            <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Acknowledged</Badge>
          ) : (
            <Badge variant="warning" className="gap-1"><AlertCircle className="h-3 w-3" /> Action required</Badge>
          )
        ) : d.requires_signature ? (
          d.signed_time ? (
            <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Signed {formatDate(d.signed_time)}</Badge>
          ) : (
            <Badge variant="warning" className="gap-1"><AlertCircle className="h-3 w-3" /> Awaiting signature</Badge>
          )
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    { id: "file_name", header: "File name", defaultHidden: true, accessor: (d) => d.file_name ?? "", cell: (d) => d.file_name || "-" },
    { id: "content_type", header: "Content type", defaultHidden: true, filter: "select", accessor: (d) => d.content_type ?? "", cell: (d) => d.content_type || "-" },
    stateColumn<DocumentResource>({ publishable: true }),
    ...metaColumns<DocumentResource>(),
    {
      id: "actions",
      header: "",
      sortable: false,
      filter: "none",
      align: "right",
      cell: (d) => {
        const locked = !!d.locked;
        const items: RowAction[] = [];
        if (d.delete_time) {
          if (writable) items.push({ label: "Restore", icon: <RotateCcw className="h-4 w-4" />, onClick: () => sd(d).restore(d) });
          if (canPurge) items.push({ label: "Delete permanently", icon: <ShieldX className="h-4 w-4" />, onClick: () => sd(d).permanentlyDelete(d), destructive: true });
        } else {
          // Download stays available even when locked (it's a read).
          if (d.size_bytes) items.push({ label: "Download", icon: <Download className="h-4 w-4" />, onClick: () => onDownload(d) });
          // On a signed copy, offer the clean source policy too (the original it was generated from).
          const original = d.source_document ? originalByPath.get(d.source_document) : undefined;
          if (original) items.push({ label: "Download original", icon: <ScrollText className="h-4 w-4" />, onClick: () => onDownload(original) });
          // View + verify the digital signature in-app (client-side; green/red/amber stamp over the widget).
          // Offered for an externally e-signed PDF that has been signed (the file carries an embedded cert).
          if (d.size_bytes && isPdfDoc(d) && d.signed_time && d.esign_provider && d.esign_provider !== "internal")
            items.push({ label: "View signature", icon: <ShieldCheck className="h-4 w-4" />, onClick: () => setViewerDoc(d) });
          // Acknowledge (employee) + view progress (HR) are reads/sign-offs - available even when locked.
          if (d.requires_ack && !d.acknowledged) items.push({ label: "Acknowledge", icon: <PenLine className="h-4 w-4" />, onClick: () => setAckDoc(d) });
          // Sign your own generated letter/contract (owner-only). Internal provider = in-app image signing; an
          // external vendor (e.g. SignYu) = open the vendor's hosted Aadhaar signing page.
          if (d.requires_signature && !d.signed_time && isMine(d)) {
            if (d.esign_url) items.push({ label: "Open to sign", icon: <ExternalLink className="h-4 w-4" />, onClick: () => window.open(d.esign_url, "_blank", "noopener") });
            else if (!d.esign_provider || d.esign_provider === "internal") items.push({ label: "Sign", icon: <PenLine className="h-4 w-4" />, onClick: () => setSignDoc(d) });
          }
          // HR: reconcile a pending external e-sign with the vendor (fallback to the webhook).
          if (writable && d.esign_provider && d.esign_provider !== "internal" && !d.signed_time) items.push({ label: "Refresh e-sign status", icon: <RefreshCw className="h-4 w-4" />, onClick: async () => { try { await invoke(d.path, "refreshEsign"); } finally { reload(); } } });
          if (writable && d.requires_ack) items.push({ label: "View acknowledgements", icon: <ClipboardCheck className="h-4 w-4" />, onClick: () => setProgressDoc(d) });
          if (locked) {
            if (writable) items.push({ label: "Unlock", icon: <Unlock className="h-4 w-4" />, onClick: () => lc(d).unlock(d) });
          } else if (writable) {
            items.push({ label: "Edit details", icon: <Pencil className="h-4 w-4" />, onClick: () => openEdit(d) });
            items.push({ label: d.size_bytes ? "Replace file" : "Upload file", icon: <Upload className="h-4 w-4" />, onClick: () => triggerReplace(d) });
            items.push(
              d.published === false
                ? { label: "Publish", icon: <Send className="h-4 w-4" />, onClick: () => lc(d).publish(d) }
                : { label: "Unpublish", icon: <FileEdit className="h-4 w-4" />, onClick: () => lc(d).unpublish(d) }
            );
            items.push(
              d.disabled
                ? { label: "Enable", icon: <CheckCircle2 className="h-4 w-4" />, onClick: () => lc(d).enable(d) }
                : { label: "Disable", icon: <Ban className="h-4 w-4" />, onClick: () => lc(d).disable(d) }
            );
            items.push({ label: "Lock", icon: <Lock className="h-4 w-4" />, onClick: () => lc(d).lock(d) });
            items.push({ label: "Delete", icon: <Trash2 className="h-4 w-4" />, onClick: () => sd(d).softDelete(d), destructive: true });
          }
        }
        // Offer the audit trail (changes, sign/ack, downloads, sensitive reads) when the caller holds the
        // activity grant for this document's collection (server still ANDs it with reading the document).
        if (canSeeActivity(caps, d.path.replace(/^\/v1\//, "").replace(/^\/+/, "").split("/")[0]))
          items.push({ label: "Activity", icon: <History className="h-4 w-4" />, onClick: () => setActivityDoc(d) });
        // A row awaiting the caller's own signature surfaces a one-click Sign button inline, rather than
        // hiding the action in the overflow menu. Covers both acknowledgement and letter/contract e-signature.
        const needsAck = !d.delete_time && d.requires_ack && !d.acknowledged;
        const needsSign = !d.delete_time && d.requires_signature && !d.signed_time && isMine(d);
        const onSign = needsAck
          ? () => setAckDoc(d)
          : d.esign_url
            ? () => window.open(d.esign_url, "_blank", "noopener")
            : (!d.esign_provider || d.esign_provider === "internal")
              ? () => setSignDoc(d)
              : null;
        return (
          <div className="flex items-center justify-end gap-1">
            {(needsAck || needsSign) && onSign && (
              <Button size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onSign}>
                <PenLine className="h-3.5 w-3.5" /> Sign
              </Button>
            )}
            <RowActions actions={items} />
          </div>
        );
      },
    },
  ];

  const isCreate = dialog?.kind === "create";
  // A document requiring acknowledgement is PDF-only; restrict the picker to match (the server enforces it too).
  const ackMode = form.employee === ORG && form.requireAck;
  // Whether the document in this dialog is a PDF: the picked file on create, the existing file on edit. The
  // "Require acknowledgement" checkbox is only enabled for PDFs (the signature is stamped in place onto it).
  const currentIsPdf = isCreate
    ? !!(file && isPdfFile(file))
    : !!(dialog?.kind === "edit" && dialog.doc.size_bytes && isPdfDoc(dialog.doc));
  // PDF bytes for the placement UI: the locally-picked File on create, or the existing doc fetched as a blob
  // on edit (POST :download). Only fetched while placing an ack on an existing PDF doc.
  const [editPdf, setEditPdf] = useState<Blob | null>(null);
  useEffect(() => {
    if (!dialog || dialog.kind !== "edit" || !ackMode || !isPdfDoc(dialog.doc)) { setEditPdf(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/v1/${dialog.doc.path}:download`, { method: "POST", credentials: "include", headers: { "X-Requested-By": "hrms-spa" } });
        if (res.ok && !cancelled) setEditPdf(await res.blob());
      } catch { /* placer shows a loading note */ }
    })();
    return () => { cancelled = true; };
  }, [dialog, ackMode]);
  const ackPdfSrc: File | Blob | null = isCreate ? (file && isPdfFile(file) ? file : null) : editPdf;
  // Fetch the signed PDF bytes for the in-app signature viewer (client-side verification; the stored file is
  // never modified). Uses the same :download endpoint as the placement flow.
  useEffect(() => {
    if (!viewerDoc) { setViewerBytes(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/v1/${viewerDoc.path}:download`, { method: "POST", credentials: "include", headers: { "X-Requested-By": "hrms-spa" } });
        if (res.ok && !cancelled) setViewerBytes(new Uint8Array(await res.arrayBuffer()));
      } catch { /* viewer shows its own loading/error state */ }
    })();
    return () => { cancelled = true; };
  }, [viewerDoc]);
  const headerActions = (
    <div className="flex items-center gap-2">
      {canGenerate && (
        <AccessAction collection="personal-documents" verb="generateLetter" label="Generate letter">
          <Button variant="outline" onClick={openGenerate}><Sparkles className="h-4 w-4" /> Generate letter</Button>
        </AccessAction>
      )}
      {writable && (
        <AccessAction collection="org-documents" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Upload document</Button></AccessAction>
      )}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Documents"
        description="Company policies, contracts, generated letters and employee files."
        actions={<>{headerActions}<PageSettings me={me} host="documents" /></>}
      />

      <input ref={replaceInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => onReplaceFile(e.target.files?.[0] ?? null)} />

      {/* Anything awaiting the caller's signature comes first - that's the one thing they must act on here. */}
      {(() => {
        const pendingForMe = topRows.filter((d) => !d.delete_time && (
          (d.requires_ack && !d.acknowledged) || (d.requires_signature && !d.signed_time && isMine(d))
        ));
        if (pendingForMe.length === 0) return null;
        return (
          <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm dark:bg-primary/10">
            <p className="mb-2 flex items-center gap-1.5 font-medium"><PenLine className="h-4 w-4 text-primary" /> {pendingForMe.length} document{pendingForMe.length === 1 ? "" : "s"} need{pendingForMe.length === 1 ? "s" : ""} your signature</p>
            <div className="flex flex-wrap gap-2">
              {pendingForMe.slice(0, 4).map((d) => (
                <Button key={d.path} variant="outline" size="sm" onClick={() => (d.requires_ack ? setAckDoc(d) : setSignDoc(d))}>
                  {d.display_name}
                </Button>
              ))}
              {pendingForMe.length > 4 && <span className="self-center text-xs text-muted-foreground">and {pendingForMe.length - 4} more below</span>}
            </div>
          </div>
        );
      })()}

      {(expiryStats.expired > 0 || expiryStats.soon > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300"><AlertCircle className="h-4 w-4" /> Document expiry</span>
          {expiryStats.expired > 0 && <span><strong>{expiryStats.expired}</strong> expired</span>}
          {expiryStats.soon > 0 && <span><strong>{expiryStats.soon}</strong> expiring within 30 days</span>}
          <span className="text-muted-foreground">Use the Expiry column filter to review.</span>
        </div>
      )}

      <DataState state={state} error={error} onRetry={reload}>
        {rows.length === 0 ? (
          <EmptyState
            icon={FileText}
            illustration="documents"
                title="No documents"
            description="Upload company-wide files or documents tied to an employee, or generate an HR letter."
            action={headerActions}
          />
        ) : (
          <DataTable
            columns={columns}
            tableId="documents"
            rows={topRows}
            getRowId={(d) => d.path}
            getSubRows={managesPolicies ? (d) => childrenByPath.get(d.path) : undefined}
            rowClassName={(d) => (d.delete_time ? "opacity-60" : undefined)}
            emptyTitle="No documents match"
            accessCollection="org-documents"
            accessTargetOf={(d) => ({ collection: d.path.split("/")[0], objectPath: d.path, label: d.display_name, can: d.access?.can })}
          />
        )}
      </DataState>

      {/* Generate letter */}
      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate letter</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Built from the employee's record, compensation and your organization's letter defaults.
          </p>
          <Field label="Employee">
            <Combobox
              value={genEmployee}
              onValueChange={setGenEmployee}
              placeholder="Select an employee…"
              searchPlaceholder="Search employees…"
              options={employees.filter((e) => !e.disabled).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))}
            />
          </Field>
          <Field label="Letter type">
            <Select value={genType} onValueChange={(v) => { setGenType(v); setGenInputs({}); setGenEsign(null); }}>
              <SelectTrigger><SelectValue placeholder="Select a letter…" /></SelectTrigger>
              <SelectContent>
                {groupByCategory(letterTemplates).map((g) => (
                  <SelectGroup key={g.category}>
                    <SelectLabel>{g.category}</SelectLabel>
                    {g.items.map((t) => <SelectItem key={t.path} value={t.path}>{t.label}</SelectItem>)}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {genTemplate?.inputs?.length ? <LetterInputFields inputs={genTemplate.inputs} values={genInputs} onChange={(k, v) => setGenInputs((s) => ({ ...s, [k]: v }))} /> : null}
          {genTemplate ? (() => {
            const templateEsign = genTemplate.blocks?.some((b) => b.kind === "esignature") ?? false;
            const effective = genEsign ?? templateEsign;
            return (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={effective} onCheckedChange={(v) => setGenEsign(v === true)} />
                Require e-signature
                <span className="text-xs text-muted-foreground">{genEsign === null ? "(from template)" : "(overridden)"}</span>
              </label>
            );
          })() : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenOpen(false)}>Cancel</Button>
            <Button onClick={generate} loading={generating} disabled={!genEmployee || !genType || missingRequiredInputs(genTemplate?.inputs, genInputs)}>Generate</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className={cn(ackMode && "max-h-[92vh] sm:max-w-5xl")}>
          <DialogHeader>
            <DialogTitle>{isCreate ? "Upload document" : "Edit document"}</DialogTitle>
          </DialogHeader>
          {/* When placing an acknowledgement signature, split into two columns: the form on the left, the PDF
              placement on the right at full height. Otherwise a single stacked column. */}
          <div className={cn(ackMode ? "flex max-h-[78vh] min-h-0 gap-6" : "grid gap-4")}>
          <div className={cn("min-w-0", ackMode ? "flex flex-1 flex-col gap-4 overflow-y-auto pr-1" : "contents")}>
          {isCreate && (
            <Field label="File">
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/40 px-4 py-6 text-center transition-colors hover:bg-accent">
                <Upload className="h-5 w-5 text-muted-foreground" />
                {file ? (
                  <span className="text-sm font-medium">{file.name} <span className="text-muted-foreground">({formatBytes(file.size)})</span></span>
                ) : (
                  <span className="text-sm text-muted-foreground">Click to choose a file</span>
                )}
                <input type="file" accept={ackMode ? "application/pdf,.pdf" : ACCEPT} className="hidden" onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
              </label>
            </Field>
          )}
          <Field label="Title">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Belongs to" hint="Organization-wide, or a specific employee's file.">
            <Combobox
              value={form.employee}
              onValueChange={(v) => setForm({ ...form, employee: v })}
              searchPlaceholder="Search…"
              options={[{ value: ORG, label: "Organization" }, ...employees.filter((e) => !e.disabled).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))]}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Type">
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Expires (optional)">
              <Input type="date" value={form.expire} onChange={(e) => setForm({ ...form, expire: e.target.value })} />
            </Field>
          </div>
          {isCreate && (
            <label className="flex items-start gap-2 rounded-lg border p-3">
              <Checkbox checked={form.published} onCheckedChange={(v) => setForm({ ...form, published: v === true })} className="mt-0.5" />
              <span>
                <span className="text-sm font-medium">Publish now</span>
                <span className="block text-xs text-muted-foreground">
                  {form.published
                    ? "Visible to everyone in scope as soon as it's uploaded."
                    : "Filed as a draft - only you (and others who can manage documents) can see it until you publish it."}
                </span>
              </span>
            </label>
          )}
          {form.employee === ORG && (
            <label className={cn("flex items-start gap-2 rounded-lg border p-3", !currentIsPdf && "cursor-not-allowed opacity-60")}>
              <Checkbox checked={form.requireAck} disabled={!currentIsPdf} onCheckedChange={(v) => setForm({ ...form, requireAck: v === true })} className="mt-0.5" />
              <span>
                <span className="text-sm font-medium">Require acknowledgement</span>
                <span className="block text-xs text-muted-foreground">
                  {currentIsPdf
                    ? "Employees who can see this document must e-sign it; each signature is stamped in place onto a signed copy of the document. Replacing the file later asks everyone to re-acknowledge the new version."
                    : "PDF only - upload a PDF file to enable acknowledgement."}
                </span>
              </span>
            </label>
          )}
          {ackMode && (
            <Field label="Signing method" hint="How employees sign their acknowledgement.">
              <div className="flex gap-2">
                {([["internal", "In-app signature"], ["cashfree", "Aadhaar e-Sign"]] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setForm({ ...form, ackMethod: val })}
                    className={cn("flex-1 rounded-md border px-3 py-2 text-sm", form.ackMethod === val ? "border-primary bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-accent")}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          )}
          {form.employee === ORG && isCreate && form.published && (
            <Field label="Notify on publish" hint={form.requireAck ? "Recipients get an action item to review & sign." : "Send an in-app notification to the chosen audience."}>
              <div className="flex items-center gap-2">
                <Select value={form.audience} onValueChange={(v) => setForm({ ...form, audience: v as typeof form.audience })}>
                  <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Don't notify</SelectItem>
                    <SelectItem value="everyone">Everyone</SelectItem>
                    <SelectItem value="specific">Specific people…</SelectItem>
                  </SelectContent>
                </Select>
                {form.audience === "specific" && (
                  <Button type="button" variant="outline" onClick={() => setPickAudience(true)}>
                    {form.audienceEmployees.length ? `${form.audienceEmployees.length} selected` : "Choose people"}
                  </Button>
                )}
              </div>
            </Field>
          )}
          </div>
          {ackMode && (
            <div className="flex min-h-0 w-[52%] shrink-0 flex-col">
              <div className="mb-1 text-sm font-medium">Signature placement</div>
              <div className="min-h-0 flex-1">
                {ackPdfSrc ? (
                  <PdfSignaturePlacer src={ackPdfSrc} value={form.signAnchor} onChange={(b) => setForm({ ...form, signAnchor: b })} />
                ) : (
                  <p className="text-sm text-muted-foreground">{isCreate ? "Choose a PDF file to place the signature." : "Loading document…"}</p>
                )}
              </div>
            </div>
          )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button onClick={submit} loading={busy} disabled={!form.name.trim()}>
              {isCreate ? "Upload" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pickAudience && (
        <EmployeePicker
          title="Notify specific people"
          confirmLabel="Select"
          employees={employees}
          departments={departments}
          onClose={() => setPickAudience(false)}
          onConfirm={(refs) => { setForm((s) => ({ ...s, audienceEmployees: refs })); setPickAudience(false); }}
        />
      )}

      {/* Acknowledge (e-sign) a document */}
      <Dialog open={!!ackDoc} onOpenChange={(o) => !o && setAckDoc(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Acknowledge document</DialogTitle></DialogHeader>
          {ackDoc && (
            <>
              <p className="text-sm text-muted-foreground">
                Please read <span className="font-medium text-foreground">{ackDoc.display_name}</span>{ackDoc.ack_version ? ` (version ${ackDoc.ack_version})` : ""}, then confirm to e-sign it{ackDoc.ack_method === "cashfree" ? " with Aadhaar (you'll verify by OTP)." : " with your signature on file."}
              </p>
              {ackDoc.size_bytes ? (
                <Button variant="outline" size="sm" className="w-fit" onClick={() => onDownload(ackDoc)}><Download className="h-4 w-4" /> Open document</Button>
              ) : (
                <p className="text-xs text-muted-foreground">No file is attached to this document.</p>
              )}
              {/* Aadhaar (Cashfree) signs in the vendor journey - no on-file signature image needed. Internal
                  signing embeds the employee's on-file signature, so that image is required. */}
              {ackDoc.ack_method === "cashfree" ? (
                <p className="text-sm text-muted-foreground">Continue opens a secure Aadhaar e-Sign page in a new tab. This document is marked acknowledged once you finish signing there.</p>
              ) : myEmp?.signature ? (
                <div className="rounded-lg border bg-white p-3 dark:bg-brand-neutral-100">
                  <p className="mb-1 text-xs text-muted-foreground dark:text-brand-neutral-500">Signing as <span className="font-medium text-foreground dark:text-brand-neutral-900">{myLegalName}</span></p>
                  <SignatureImage employeeId={idOf(myEmp.path)} signature={myEmp.signature} className="max-h-16 object-contain" />
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="space-y-1.5">
                    <p>A signature on file is required to acknowledge documents.</p>
                    <Button variant="outline" size="sm" onClick={() => { setAckDoc(null); navigate("profile"); }}>Add your signature</Button>
                  </div>
                </div>
              )}
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAckDoc(null)}>Cancel</Button>
            <Button onClick={doAcknowledge} loading={busy} disabled={ackDoc?.ack_method !== "cashfree" && !myEmp?.signature}>
              {ackDoc?.ack_method === "cashfree" ? <><ExternalLink className="h-4 w-4" /> Continue to Aadhaar e-Sign</> : <><PenLine className="h-4 w-4" /> Acknowledge</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* In-app digital-signature viewer: verifies the embedded signature client-side and draws the
          valid/invalid/unknown stamp over the signature widget. The stored PDF is never modified. */}
      <Dialog open={!!viewerDoc} onOpenChange={(o) => !o && setViewerDoc(null)}>
        <DialogContent className="flex h-[85vh] max-w-4xl flex-col">
          <DialogHeader><DialogTitle className="truncate pr-6">{viewerDoc?.display_name}</DialogTitle></DialogHeader>
          {viewerBytes
            ? <Suspense fallback={<div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading viewer…</div>}><SignedPdfViewer bytes={viewerBytes} /></Suspense>
            : <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading document…</div>}
        </DialogContent>
      </Dialog>

      {/* Document activity: changes, sign/ack, downloads and sensitive reads for this document. */}
      <Dialog open={!!activityDoc} onOpenChange={(o) => !o && setActivityDoc(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Activity</DialogTitle></DialogHeader>
          {activityDoc && <ActivityFeed resource={activityDoc.path} />}
        </DialogContent>
      </Dialog>

      {/* Sign (e-sign) a generated letter/contract in place */}
      <Dialog open={!!signDoc} onOpenChange={(o) => !o && setSignDoc(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Sign document</DialogTitle></DialogHeader>
          {signDoc && (
            <>
              <p className="text-sm text-muted-foreground">
                Please review <span className="font-medium text-foreground">{signDoc.display_name}</span>, then confirm to sign. Your signature on file is placed on the document and it is locked.
              </p>
              {signDoc.size_bytes ? (
                <Button variant="outline" size="sm" className="w-fit" onClick={() => onDownload(signDoc)}><Download className="h-4 w-4" /> Open document</Button>
              ) : null}
              {myEmp?.signature ? (
                <div className="rounded-lg border bg-white p-3 dark:bg-brand-neutral-100">
                  <p className="mb-1 text-xs text-muted-foreground dark:text-brand-neutral-500">Signing as <span className="font-medium text-foreground dark:text-brand-neutral-900">{myLegalName}</span></p>
                  <SignatureImage employeeId={idOf(myEmp.path)} signature={myEmp.signature} className="max-h-16 object-contain" />
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="space-y-1.5">
                    <p>A signature on file is required to sign documents.</p>
                    <Button variant="outline" size="sm" onClick={() => { setSignDoc(null); navigate("profile"); }}>Add your signature</Button>
                  </div>
                </div>
              )}
            </>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSignDoc(null)}>Cancel</Button>
            <Button onClick={doSign} disabled={busy || !myEmp?.signature}><PenLine className="h-4 w-4" /> Sign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {progressDoc && <AckProgressDialog doc={progressDoc} employees={employees} onClose={() => setProgressDoc(null)} />}
    </div>
  );
}

// HR view: who has acknowledged the current version of a policy, and who's still pending. Pending is computed
// against active employees (an approximation of "everyone who can see it").
function AckProgressDialog({ doc, employees, onClose }: { doc: DocumentResource; employees: Employee[]; onClose: () => void }) {
  const [acks, setAcks] = useState<DocumentAcknowledgement[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    api<{ results: DocumentAcknowledgement[] }>(`/document-acknowledgements?document=${encodeURIComponent(doc.path)}&max_page_size=500`)
      .then((r) => { if (live) { setAcks(r.results ?? []); setLoaded(true); } })
      .catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [doc.path]);

  const version = doc.ack_version ?? 1;
  const current = acks.filter((a) => a.version === version && a.employee);
  const signedById = new Map(current.map((a) => [idOf(a.employee!), a]));
  const active = employees.filter((e) => !e.delete_time && !e.disabled);
  const pending = active.filter((e) => !signedById.has(idOf(e.path)));
  const empName = (e: Employee) => `${e.first_name} ${e.last_name}`;
  // The "certificate" is the policy PDF with the signature page appended - i.e. the employee's signed copy.
  const signedName = (e: Employee | undefined, a: DocumentAcknowledgement) =>
    `${e ? empName(e) : idOf(a.employee!)} - ${doc.display_name} (signed).pdf`;
  // Sequential so the browser doesn't drop concurrent saves.
  const downloadAllSigned = async (rows: DocumentAcknowledgement[]) => {
    for (const a of rows) {
      if (!a.signed_document) continue;
      const e = employees.find((x) => idOf(x.path) === idOf(a.employee!));
      await downloadFile(a.signed_document, signedName(e, a));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Acknowledgements · {doc.display_name}</DialogTitle></DialogHeader>
        {!loaded ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{current.length} of {active.length} acknowledged · version {version}</p>
            <div className="max-h-[60vh] space-y-4 overflow-y-auto">
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> Signed ({current.length})</p>
                  {current.some((a) => a.signed_document) && (
                    <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => downloadAllSigned(current)}>
                      <Download className="mr-1 h-3.5 w-3.5" /> Download all signed
                    </Button>
                  )}
                </div>
                {current.length === 0 ? <p className="text-sm text-muted-foreground">No one yet.</p> : (
                  <div className="space-y-1">
                    {current.map((a) => {
                      const e = employees.find((x) => idOf(x.path) === idOf(a.employee!));
                      return (
                        <div key={a.path} className="flex items-center gap-2 rounded-md border p-2">
                          <PhotoAvatar employeeId={idOf(a.employee!)} name={e ? empName(e) : ""} photo={e?.photo} className="h-7 w-7" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{e ? empName(e) : idOf(a.employee!)}</p>
                            <p className="truncate text-xs text-muted-foreground">Signed "{a.signature}"{a.acknowledged_time ? ` · ${formatDate(a.acknowledged_time)}` : ""}</p>
                          </div>
                          {a.signed_document && (
                            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => downloadFile(a.signed_document!, signedName(e, a))}>
                              <Download className="mr-1 h-3.5 w-3.5" /> Signed copy
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" /> Pending ({pending.length})</p>
                {pending.length === 0 ? <p className="text-sm text-muted-foreground">Everyone has acknowledged.</p> : (
                  <div className="flex flex-wrap gap-1.5">
                    {pending.map((e) => (
                      <span key={e.path} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
                        <PhotoAvatar employeeId={idOf(e.path)} name={empName(e)} photo={e.photo} className="h-4 w-4 text-[8px]" /> {empName(e)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
