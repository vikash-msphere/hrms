import { useEffect, useMemo, useRef, useState, Suspense } from "react";
// lazyPage, not React.lazy: a failed import must stay retryable (see lib/lazyPage.tsx and the crash boundary).
import { lazyPage as lazy } from "@/lib/lazyPage";
import {
  FileText, Plus, Trash2, Download, Upload, RotateCcw, ShieldX, ShieldPlus, ScrollText, FileBadge, FileLock, File, History,
  FileImage, FileSpreadsheet, FileArchive, FileVideo, FileAudio, Pencil, Building2, UserRound,
  Lock, Unlock, Send, FileEdit, CheckCircle2, Ban, FileSignature, Sparkles, PenLine, ClipboardCheck, AlertCircle,
  RefreshCw, ExternalLink, ShieldCheck, Copy, CalendarClock, BellRing, Eye,
} from "lucide-react";
import { api, get, getAllPages, upload, patch, invoke, blobOf, download as downloadFile } from "@/api";
import { describeError } from "@/lib/formError";
import { documentDownloadItems, useDocumentDownload } from "@/components/common/DocumentDownload";
import { useDocuments, createDocument, docCollection, documentFileName } from "@/lib/documents";
import { useCollection } from "@/hooks/useCollection";
import { useSoftDelete } from "@/hooks/useSoftDelete";
import { useLifecycle } from "@/hooks/useLifecycle";
import { usePermission, useCapabilities, canSeeActivity, useCanSeeActivity } from "@/lib/perm";
import { cn, formatBytes, formatDate, humanize, idOf } from "@/lib/utils";
import { isExternalUrl, openExternal } from "@/lib/openExternal";
import { todayStr, addDaysYmd } from "@/lib/orgDay";
import { daysUntil, fmtDaysCount } from "@/lib/tableDerive";
import { Checkbox } from "@/components/ui/checkbox";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { RupeeCircle } from "@/components/icons/RupeeCircle";
import { PdfSignaturePlacer } from "@/components/common/PdfSignaturePlacer";
// Lazy so the signature verifier (PKI.js) + pdf.js only load when a signature is actually viewed.
const SignedPdfViewer = lazy(() => import("@/components/common/SignedPdfViewer").then((m) => ({ default: m.SignedPdfViewer })));
import type { ActivityPage, DocumentResource, DocumentAcknowledgement, Employee, Department, Me, SignBox } from "@/types";
import { EmployeePicker } from "@/components/common/EmployeePicker";
import { PageHeader } from "@/components/common/PageHeader";
import { useIntent } from "@/lib/intent";
import { PageSettings } from "@/components/common/SettingsButton";
import { DataState } from "@/components/common/DataState";
import { TruncationNotice } from "@/components/common/TruncationNotice";
import { EmptyState } from "@/components/common/EmptyState";
import { PageSkeleton, TableSkeleton } from "@/components/common/Skeletons";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, type Column } from "@/components/common/DataTable";
import { type TableInsight } from "@/components/common/TableInsights";
import { stateColumn } from "@/components/common/stateColumn";
import { metaColumns } from "@/components/common/metaColumns";
import { RowActions, type RowAction } from "@/components/common/RowActions";
import { ActivityFeed } from "@/components/common/ActivityFeed";
import { ActivitySection } from "@/components/common/ActivitySection";
import { Field, FieldRow } from "@/components/common/Field";
import { FileDropField } from "@/components/common/FileDropField";
import { WriteDialog } from "@/components/common/WriteDialog";
import { GenerateLetterDialog } from "@/components/common/GenerateLetterDialog";
import { Form16BatchButton } from "@/components/common/Form16BatchButton";
import { SignDocumentDialog } from "@/components/common/SignDocumentDialog";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/common/SearchInput";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

const TYPES = ["CONTRACT", "ID", "PAYSLIP", "POLICY", "LETTER", "INSURANCE", "OTHER"];
const TYPE_ICON: Record<string, typeof File> = { CONTRACT: ScrollText, ID: FileBadge, PAYSLIP: RupeeCircle, POLICY: FileLock, LETTER: FileSignature, INSURANCE: ShieldPlus, OTHER: File };
// Local calendar date - toISOString() would call a doc that expires today "valid" until UTC catches up.
// `todayStr` comes from lib/orgDay: the ORG's day. This file used to define its own from the browser's
// local parts, which is a different day for part of every day and a different day again from the one the
// server validates against.
// `expire_time` is a date-time on the wire but a calendar day to every reader here, so a day picked in the
// form goes out as UTC midnight: that is the one stamp whose `slice(0, 10)` reads back as the same day in
// every timezone. A local-midnight or end-of-day stamp would land on the neighbouring day off UTC.
const dayToExpireTime = (day: string) => `${day}T00:00:00Z`;

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
  const { rows, state, error, reload, reloadOrg, reloadPersonal } = useDocuments({ showDeleted: true });
  // COMPLETE: this one list feeds the letter/Form-16 pickers AND the acknowledgement dialog's "who is still
  // pending" roster, which is a compliance answer - on a window it names people who have already signed.
  const { rows: employees, state: employeesState } = useCollection<Employee>("employees", { all: true });
  const { rows: departments } = useCollection<Department>("departments", { all: true });
  const [pickAudience, setPickAudience] = useState(false);
  // The acknowledging user's own record (for their signature image + name on the acknowledge dialog).
  const myEmp = useMemo(() => employees.find((e) => idOf(e.path) === me.employee_id), [employees, me.employee_id]);
  const { toast } = useToast();
  // Per-resource soft-delete/lifecycle flows; the right one is picked per row by ownership (org vs personal).
  // Each takes the reload for ITS OWN resource: acting on an org document has nothing to say about personal ones,
  // and reloading both is how this page used to spend two list reads per action.
  const sdOrg = useSoftDelete("org-documents", "document", reloadOrg);
  const sdPersonal = useSoftDelete("personal-documents", "document", reloadPersonal);
  const lcOrg = useLifecycle("org-documents", "document", reloadOrg);
  const lcPersonal = useLifecycle("personal-documents", "document", reloadPersonal);
  const sd = (d: DocumentResource) => (docCollection(d) === "personal-documents" ? sdPersonal : sdOrg);
  const lc = (d: DocumentResource) => (docCollection(d) === "personal-documents" ? lcPersonal : lcOrg);

  // Each `usePermission` is read into its own const before the booleans are combined. `||` and `&&`
  // SHORT-CIRCUIT, so `usePermission(a) || usePermission(b)` skips the second hook whenever the first is true -
  // and the moment `a` flips (capabilities arrive after the first paint, and change on a grant edit) the
  // component renders a different number of hooks than last time, which React refuses. Same hazard, same fix,
  // in PayrollRuns and Profile.
  const orgWrite = usePermission("org-documents.write");
  const personalWrite = usePermission("personal-documents.write");
  const orgAdmin = usePermission("org-documents.admin");
  const personalAdmin = usePermission("personal-documents.admin");
  const writable = orgWrite || personalWrite;
  const canPurge = orgAdmin || personalAdmin;
  const caps = useCapabilities(); // for per-document activity gating (a doc may be org- or personal-scoped)
  // Letter generation is HR + super only (personal-documents.write distinguishes them from employees, who
  // hold only read on their own docs). The server enforces the real gate (personal-documents.generateLetter).
  const canGenerate = usePermission("personal-documents.write");

  const empName = useMemo(() => {
    const m = new Map(employees.map((e) => [idOf(e.path), `${e.first_name} ${e.last_name}`]));
    // A word, never the wire id (lib/utils.ts `personName`): the list is scoped to what the caller may read,
    // so a document issued to somebody outside that slice must not print a uuid as its owner.
    return (p?: string) => (p ? m.get(idOf(p)) ?? "Someone" : "");
  }, [employees]);

  const [dialog, setDialog] = useState<Mode | null>(null);
  const [form, setForm] = useState(EMPTY);
  // Files staged for a create. A shelf is loaded from a folder of scans, so the dialog takes a list and files
  // one document per file, sharing the type, scope and expiry that were set once.
  const [files, setFiles] = useState<File[]>([]);
  // Which of the staged files this dialog has already filed, so a retry after a partial batch resumes rather
  // than restarting (see `submit`). Cleared when the dialog closes, below.
  const filedThisDialog = useRef(new Set<File>());
  const file = files[0] ?? null;
  const [dragOver, setDragOver] = useState(false);
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

  // Generate-letter dialog: the whole form (employee, template, inputs, e-sign choice, preview) lives in the
  // shared dialog, which the employee profile opens too.
  const [genOpen, setGenOpen] = useState(false);

  // Hidden input used by the per-row "Replace file" / "Renew" actions (renew also moves the expiry on).
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<DocumentResource | null>(null);
  const renewTarget = useRef(false);

  function openCreate() {
    setForm(EMPTY);
    setFiles([]);
    setDialog({ kind: "create" });
  }
  useIntent("new-document", openCreate);
  // Dropping files on the page opens the same dialog already loaded - the type, scope and expiry are still one
  // decision, but nobody has to find the picker first.
  function openCreateWith(dropped: File[]) {
    setForm({ ...EMPTY, name: dropped.length === 1 ? stripExt(dropped[0]!.name) : "" });
    setFiles(dropped);
    setDialog({ kind: "create" });
  }
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
    setFiles([]);
    setDialog({ kind: "edit", doc: d });
  }

  function onPickFiles(picked: File[]) {
    setFiles(picked);
    const f = picked[0] ?? null;
    // Acknowledgement is PDF-only and places ONE signature box, so it needs a single PDF: clearing the file, a
    // non-PDF, or a batch all turn it off.
    setForm((s) => ({
      ...s,
      name: picked.length === 1 && f && !s.name.trim() ? stripExt(f.name) : s.name,
      requireAck: picked.length === 1 && f && isPdfFile(f) ? s.requireAck : false,
    }));
  }

  function bodyFromForm(title = form.name) {
    return {
      display_name: title,
      document_type: form.type,
      employee: form.employee === ORG ? "" : form.employee,
      // `expire_time` is `format: date-time`, and "" is not one - an empty expiry is left out.
      ...(form.expire ? { expire_time: dayToExpireTime(form.expire) } : {}),
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

  // Throws to fail: WriteDialog turns the throw into the message inside the form and keeps what was typed.
  async function submit() {
    if (!dialog) return;
    if (dialog.kind === "edit") {
      await patch(dialog.doc.path, bodyFromForm(), dialog.doc.etag);
      toast({ title: "Document updated", variant: "success" });
      reload();
      return;
    }
    if (files.length > 1) {
      // A batch: one document per file, each titled from its own file name, everything else shared. Sequential
      // on purpose - the upload path is one subrequest per file and a burst of them is what trips the free tier.
      //
      // RESUMABLE. A throw reaches WriteDialog, which turns it into an in-form message and keeps every one of
      // the staged files - so pressing Submit again re-ran the loop from the start and created a SECOND copy of
      // everything that had already landed, multiplying on every retry. `filed` survives between attempts (it
      // is a ref on the dialog), so a retry resumes at the file that failed. Same shape as Attendance's
      // `submitCorrection` and ExpenseBudgets' `commitRoll`.
      let made = 0;
      for (const f of files) {
        if (filedThisDialog.current.has(f)) continue;
        try {
          const doc = await createDocument({ ...bodyFromForm(stripExt(f.name)), published: form.published });
          await upload(doc.path, f);
        } catch (e) {
          reload(); // whatever did land is real, and belongs on screen
          throw new Error(`Uploaded ${made} of ${files.length}. ${describeError(e)} Press Submit again to carry on from "${f.name}".`);
        }
        filedThisDialog.current.add(f);
        made++;
      }
      toast({ title: `${files.length} documents uploaded`, variant: "success" });
    } else {
      const doc = await createDocument({ ...bodyFromForm(), published: form.published });
      // The document EXISTS from here on, so a failed upload must not read as a failed save. Keep the record,
      // close the dialog, and say what is missing - every route to this page has an attach-to-existing path
      // (the replace/upload button on the row).
      if (file) {
        try {
          await upload(doc.path, file);
        } catch (e) {
          reload();
          toast({
            variant: "destructive",
            title: "Added, but the file didn't attach",
            description: `${describeError(e)} The document is on the list - use its upload button to attach the file.`,
          });
          return;
        }
      }
      toast({ title: file ? "Document uploaded" : "Document added", variant: "success" });
    }
    reload();
  }

  function triggerReplace(d: DocumentResource, renew = false) {
    replaceTarget.current = d;
    renewTarget.current = renew;
    replaceInput.current?.click();
  }

  // A renewal moves the expiry by the same span it had before (a year for most paperwork), measured from the
  // date that just lapsed - so renewing an insurance card that expired in March lands next March, not next
  // month. From today when the previous window can't be worked out.
  function renewedExpiry(d: DocumentResource): string {
    // `prev` already falls back to today when there was no previous expiry to measure from - comparing it
    // against today again here (the bug this replaced) meant ANY already-lapsed document - the only kind
    // "Renew" is ever offered on - renewed to "a year from today" regardless of when it actually expired,
    // silently dropping the whole point of measuring from the lapsed date.
    // Day strings throughout, anchored at UTC: the old form parsed local midnight and read the LOCAL parts
    // back, so a renewal set from a machine east of UTC landed on the day before the anniversary.
    const prev = d.expire_time ? d.expire_time.slice(0, 10) : todayStr();
    const next = new Date(`${prev}T00:00:00Z`);
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    return next.toISOString().slice(0, 10);
  }

  async function onReplaceFile(f: File | null) {
    const d = replaceTarget.current;
    const renew = renewTarget.current;
    if (!f || !d) return;
    if (d.requires_ack && !isPdfFile(f)) {
      toast({ title: "Policies must be PDFs", description: "A policy requiring acknowledgement can only be replaced with a PDF.", variant: "destructive" });
      replaceTarget.current = null;
      renewTarget.current = false;
      if (replaceInput.current) replaceInput.current.value = "";
      return;
    }
    try {
      await upload(d.path, f);
      if (renew) {
        // The whole point of a renewal: the new paperwork AND the date it runs to, in one action. Before this
        // it was an upload, then a trip through the edit dialog to move a date nobody remembered to move.
        const expire = renewedExpiry(d);
        await patch(d.path, { expire_time: dayToExpireTime(expire) });
        toast({ title: "Renewed", description: `${d.display_name} now expires ${formatDate(expire)}.`, variant: "success" });
      } else {
        toast({ title: "File uploaded", variant: "success" });
      }
      reload();
    } catch (e) {
      toast({ title: renew ? "Renewal failed" : "Upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      replaceTarget.current = null;
      renewTarget.current = false;
      if (replaceInput.current) replaceInput.current.value = "";
    }
  }

  // Downloading is shared with the profile's Documents tab, so both offer the print version on exactly the
  // documents that have one - and neither offers it on the ones that don't.
  const { run: runDownload } = useDocumentDownload();
  const onDownload = (d: DocumentResource) => void runDownload(d, "screen");

  const today = todayStr();
  // Expiry tracking: a doc is "Expiring soon" within 30 days of its expire_time, "Expired" once past.
  const soonCutoff = addDaysYmd(today, 30);
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

  // A document library is not read like a list; it is read for the four things that make one a liability:
  // what has lapsed, what is about to, what is waiting on a person, and what has no file behind it at all.
  const documentInsights = (ds: DocumentResource[]): TableInsight[] => {
    const live = ds.filter((d) => !d.delete_time);
    const out: TableInsight[] = [];
    const chip = (id: string, n: number, label: string, tone: TableInsight["tone"], filters: Record<string, string>, hint?: string, sort?: string) => {
      if (n > 0) out.push({ id, label: `${n} ${label}`, tone, filters, hint, sort });
    };
    chip("expired", live.filter((d) => expiryBucket(d) === "Expired").length, "expired", "destructive", { expires: "Expired" }, "Past their expiry date and still on file.", "expiry_date.asc");
    chip("soon", live.filter((d) => expiryBucket(d) === "Expiring soon").length, "expiring within 30 days", "warning", { expires: "Expiring soon" }, undefined, "expiry_date.asc");
    chip("unsigned", live.filter((d) => d.requires_signature && !d.signed_time).length, "awaiting a signature", "warning", { compliance: "Awaiting signature" });
    chip("unacked", live.filter((d) => d.requires_ack && !d.acknowledged).length, "not yet acknowledged", "warning", { compliance: "Action required" });
    chip("nofile", live.filter((d) => !d.size_bytes).length, "with no file attached", "neutral", { file: "Missing" }, "A record with nothing behind it.");
    return out;
  };

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
    { id: "type", header: "Type", filter: "select", groupBy: true, accessor: (d) => humanize(d.document_type), cell: (d) => <Badge variant="secondary">{humanize(d.document_type)}</Badge> },
    {
      id: "owner",
      header: "Belongs to",
      filter: "select",
      groupBy: true,
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
      filter: "select",
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
      // Filter/group by status (expired / expiring soon / valid); the date is shown in the cell, and the
      // hidden "Expiry date" column below is the one to filter by when the question is a calendar window
      // rather than a bucket ("what runs out before the audit in March").
      filter: "select",
      groupBy: true,
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
      id: "expiry_date",
      header: "Expiry date",
      defaultHidden: true,
      filter: "date",
      dateHint: "future",
      accessor: (d) => d.expire_time ?? "",
      cell: (d) => (d.expire_time ? formatDate(d.expire_time) : <span className="text-muted-foreground">-</span>),
    },
    {
      id: "compliance",
      header: "Acknowledgement",
      filter: "select",
      groupBy: true,
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
    {
      // The expiry as a NUMBER of days. The bucket column answers "expired / soon / valid" and the date
      // column answers a calendar window; neither answers "everything that runs out inside 90 days", which
      // is how a document library is actually reviewed. Negative once it has already gone.
      id: "expires_in", header: "Expires in", align: "right", defaultHidden: true, filter: "number", formatTotal: fmtDaysCount,
      accessor: (d) => daysUntil(d.expire_time),
      cell: (d) => {
        const days = daysUntil(d.expire_time);
        if (days == null) return <span className="text-muted-foreground">-</span>;
        return <span className={cn("tabular-nums text-xs", days < 0 ? "font-medium text-destructive" : days <= 30 ? "text-warning" : "text-muted-foreground")}>
          {days < 0 ? `${fmtDaysCount(-days)} ago` : fmtDaysCount(days)}
        </span>;
      },
    },
    {
      // What the library costs to hold, and which single record is a forty-megabyte scan. Summed, because
      // "how much is in here" is the question a storage bill asks.
      id: "size", header: "Size", align: "right", defaultHidden: true, filter: "number", aggregate: "sum",
      formatTotal: (n) => formatBytes(n),
      accessor: (d) => d.size_bytes ?? null,
      cell: (d) => (d.size_bytes ? <span className="tabular-nums text-muted-foreground">{formatBytes(d.size_bytes)}</span> : <span className="text-muted-foreground">-</span>),
    },
    { id: "file_name", header: "File name", defaultHidden: true, accessor: (d) => d.file_name ?? "", cell: (d) => d.file_name || "-" },
    { id: "content_type", header: "Content type", defaultHidden: true, filter: "select", groupBy: true, accessor: (d) => d.content_type ?? "", cell: (d) => d.content_type || "-" },
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
          // Download stays available even when locked (it's a read). One entry, or two when this document's
          // letterhead has a print version as well - decided by the row, not by the document type.
          items.push(...documentDownloadItems(d, (doc, v) => void runDownload(doc, v)));
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
            // `openExternal` rather than a bare window.open: `esign_uri` is the vendor's own JSON field,
            // stored verbatim, and a `javascript:` URL opened from here would run in this origin.
            if (isExternalUrl(d.esign_uri)) items.push({ label: "Open to sign", icon: <ExternalLink className="h-4 w-4" />, onClick: () => openExternal(d.esign_uri) });
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
            // Renewal is its own act: new paperwork plus the date it runs to. Offered where it means something -
            // a document that carries an expiry and has lapsed or is about to.
            if (d.expire_time && expiryBucket(d) !== "Valid")
              items.push({ label: `Renew to ${formatDate(renewedExpiry(d))}`, icon: <CalendarClock className="h-4 w-4" />, onClick: () => triggerReplace(d, true) });
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
          : isExternalUrl(d.esign_uri)
            ? () => openExternal(d.esign_uri)
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
    void (async () => {
      try {
        // Through the API client, never a hand-rolled fetch: `blobOf` is what carries the simulation rules
        // (a binary method is a POST, which "view as" refuses), the 401 -> session-expired handoff and the
        // transient retry. A raw fetch here answered as the REAL admin during a simulation, so an HR admin
        // checking what an employee sees was shown a PDF that employee cannot open.
        const blob = await blobOf(dialog.doc.path);
        if (!cancelled) setEditPdf(blob);
      } catch { /* placer shows a loading note */ }
    })();
    return () => { cancelled = true; };
  }, [dialog, ackMode]);
  const ackPdfSrc: File | Blob | null = isCreate ? (file && isPdfFile(file) ? file : null) : editPdf;

  // ---- what the save will do, and what is standing in its way ---------------------------------------------
  // The dialog used to fail these three at submit time with a toast that landed BEHIND it. They belong on the
  // button instead: a greyed-out Save that says why beats an invisible error.
  const pickedNonPdf = isCreate && !!file && !isPdfFile(file);
  const ackNeedsPdf = ackMode && !currentIsPdf;
  const ackNeedsAnchor = ackMode && currentIsPdf && !form.signAnchor;
  const audienceEmpty = form.audience === "specific" && form.audienceEmployees.length === 0;
  // A batch takes its titles from the file names, so the title box isn't a requirement there.
  const batch = isCreate && files.length > 1;
  const needsTitle = !batch && !form.name.trim();
  const canSubmit = !needsTitle && !ackNeedsPdf && !ackNeedsAnchor && !audienceEmpty;
  const whyNot = needsTitle
    ? "Give the document a title."
    : ackNeedsPdf
      ? isCreate ? "Acknowledgement needs a PDF - choose one, or turn it off." : "Replace the file with a PDF before requiring acknowledgement."
      : ackNeedsAnchor
        ? "Click on the document to place the signature box."
        : "Choose who to notify, or switch the audience to nobody.";

  // Everything awaiting the caller's own signature, in list order - the queue the sign dialog walks. Two
  // separate acts (acknowledging a company policy, signing your own letter), so two queues.
  const ackQueue = useMemo(() => topRows.filter((d) => !d.delete_time && d.requires_ack && !d.acknowledged), [topRows]);
  const signQueue = useMemo(
    () => topRows.filter((d) => !d.delete_time && d.requires_signature && !d.signed_time && !!d.employee && idOf(d.employee) === me.employee_id),
    [topRows, me.employee_id],
  );
  // The sign dialogs show the row AS IT IS NOW, not the copy captured when Sign was pressed. An upload writes
  // the record and then its bytes, and the list re-read that the create set off can land in between - so a
  // Sign pressed right after uploading held a row with no file: no reader, "No file is attached", and the
  // read-it-first gate open on a document nobody had been shown. Falls back to the captured row once the
  // list no longer has it, which is the dialog's own "this document has been removed" case.
  const liveAckDoc = useMemo(() => (ackDoc ? rows.find((r) => r.path === ackDoc.path) ?? ackDoc : null), [rows, ackDoc]);
  const liveSignDoc = useMemo(() => (signDoc ? rows.find((r) => r.path === signDoc.path) ?? signDoc : null), [rows, signDoc]);

  // A date typed into a bare date field says nothing about what it means; this turns it back into English
  // (and catches the year typo that files a contract as already expired).
  const expiryHint = (() => {
    if (!form.expire) return "Leave blank for a document that doesn't lapse.";
    const days = Math.round((Date.parse(`${form.expire}T00:00:00`) - Date.parse(`${todayStr()}T00:00:00`)) / 86400000);
    if (Number.isNaN(days)) return undefined;
    if (days < 0) return `Already expired ${-days} ${-days === 1 ? "day" : "days"} ago - it will show as Expired.`;
    if (days === 0) return "Expires today.";
    if (days <= 30) return `Expires in ${days} ${days === 1 ? "day" : "days"} - shows as Expiring soon.`;
    return `Expires in ${days} days.`;
  })();

  // Everyone an org-wide document reaches, so "Require acknowledgement" and "Notify" say how many people this
  // actually lands on rather than leaving it to be discovered afterwards.
  const activeCount = useMemo(() => employees.filter((e) => !e.disabled && !e.delete_time).length, [employees]);
  // Two records of one policy is two acknowledgement trails and two expiry dates. Warn, never block: a yearly
  // "Code of conduct" legitimately exists more than once.
  const titleClash = useMemo(() => {
    const n = form.name.trim().toLowerCase();
    if (!n) return null;
    const sameScope = (d: DocumentResource) => (d.employee ? `employees/${idOf(d.employee)}` : ORG) === form.employee;
    return rows.find((d) => !d.delete_time && d.path !== (dialog?.kind === "edit" ? dialog.doc.path : "") && sameScope(d) && d.display_name.trim().toLowerCase() === n) ?? null;
  }, [rows, form.name, form.employee, dialog]);

  // Fetch the signed PDF bytes for the in-app signature viewer (client-side verification; the stored file is
  // never modified). Uses the same :download endpoint as the placement flow.
  useEffect(() => {
    if (!viewerDoc) { setViewerBytes(null); return; }
    let cancelled = false;
    void (async () => {
      try {
        const bytes = new Uint8Array(await (await blobOf(viewerDoc.path)).arrayBuffer());
        if (!cancelled) setViewerBytes(bytes);
      } catch { /* viewer shows its own loading/error state */ }
    })();
    return () => { cancelled = true; };
  }, [viewerDoc]);
  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      {canGenerate && (
        <AccessAction collection="personal-documents" verb="generateLetter" label="Generate letter">
          <Button variant="outline" onClick={() => setGenOpen(true)}><Sparkles className="h-4 w-4" /> Generate letter</Button>
        </AccessAction>
      )}
      {/* Year-end: the same document for the whole company, which the per-employee button can't do. */}
      {canGenerate && (
        <Form16BatchButton
          employees={employees}
          departments={departments}
          loading={employeesState === "loading"}
          onGenerated={reload}
        />
      )}
      {writable && (
        <AccessAction collection="org-documents" create><Button onClick={openCreate}><Plus className="h-4 w-4" /> Upload document</Button></AccessAction>
      )}
    </div>
  );

  return (
    <div
      // Dropping paperwork onto the shelf is how it arrives: out of a mail client, off a scanner folder. Only
      // for someone who may file it, and only for an actual file drag (not a row drag inside the table).
      onDragOver={writable ? (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } } : undefined}
      onDragLeave={writable ? (e) => { if (e.currentTarget === e.target) setDragOver(false); } : undefined}
      onDrop={writable ? (e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(false);
        const dropped = Array.from(e.dataTransfer.files ?? []);
        if (dropped.length) openCreateWith(dropped);
      } : undefined}
      className={cn("rounded-lg", dragOver && "ring-2 ring-primary ring-offset-4 ring-offset-background")}
    >
      <PageHeader
        title="Documents"
        description="Company policies, contracts, generated letters and employee files."
        actions={<>{headerActions}<PageSettings me={me} host="documents" /></>}
      />
      {dragOver && (
        <p className="mb-3 rounded-lg border border-dashed border-primary bg-primary/5 p-3 text-center text-sm font-medium text-primary">
          Drop to file - one document per file
        </p>
      )}

      <input ref={replaceInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => onReplaceFile(e.target.files?.[0] ?? null)} />

      {/* Anything awaiting the caller's signature comes first - that's the one thing they must act on here.
          "Sign them all" opens the dialog on the queue: one dialog walks the pile instead of four openings. */}
      {ackQueue.length + signQueue.length > 0 && (
        <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm dark:bg-primary/10">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-1.5 font-medium">
              <PenLine className="h-4 w-4 text-primary" />
              {ackQueue.length + signQueue.length} document{ackQueue.length + signQueue.length === 1 ? "" : "s"} need{ackQueue.length + signQueue.length === 1 ? "s" : ""} your signature
            </p>
            {ackQueue.length + signQueue.length > 1 && (
              <Button size="sm" onClick={() => (ackQueue[0] ? setAckDoc(ackQueue[0]) : setSignDoc(signQueue[0]!))}>
                <PenLine className="h-4 w-4" /> Sign them all
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {[...ackQueue, ...signQueue].slice(0, 4).map((d) => (
              <Button key={d.path} variant="outline" size="sm" onClick={() => (d.requires_ack ? setAckDoc(d) : setSignDoc(d))}>
                {d.display_name}
              </Button>
            ))}
            {ackQueue.length + signQueue.length > 4 && <span className="self-center text-xs text-muted-foreground">and {ackQueue.length + signQueue.length - 4} more below</span>}
          </div>
        </div>
      )}

      {(expiryStats.expired > 0 || expiryStats.soon > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30">
          <span className="inline-flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300"><AlertCircle className="h-4 w-4" /> Document expiry</span>
          {expiryStats.expired > 0 && <span><strong>{expiryStats.expired}</strong> expired</span>}
          {expiryStats.soon > 0 && <span><strong>{expiryStats.soon}</strong> expiring within 30 days</span>}
          <span className="text-muted-foreground">Use the Expiry column filter to review.</span>
        </div>
      )}

      {/* Both resources are capped at one server page and this view filters/sorts the cached rows, so it has to
          admit when it is looking at a window rather than the whole shelf. */}
      <TruncationNotice collection={["org-documents", "personal-documents"]} what="documents" className="mb-3" />
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
            insights={documentInsights}
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

      <GenerateLetterDialog
        open={genOpen}
        onClose={() => setGenOpen(false)}
        employees={employees}
        departments={departments}
        onGenerated={reload}
      />

      <WriteDialog
        open={!!dialog}
        onClose={() => { setDialog(null); filedThisDialog.current = new Set(); }}
        title={isCreate ? "Upload document" : "Edit document"}
        description={
          form.employee === ORG
            ? form.requireAck
              ? `A company policy every reader must e-sign - ${activeCount} active ${activeCount === 1 ? "employee" : "employees"} today.`
              : "Filed on the company shelf: readable by everyone the document's access allows."
            : "Filed in this employee's own file, alongside their letters and payslips."
        }
        collection={form.employee === ORG ? "org-documents" : "personal-documents"}
        objectPath={dialog?.kind === "edit" ? dialog.doc.path : undefined}
        guardLabel="document"
        // The picked files are part of what would be lost, so the discard guard has to see them change.
        form={{ ...form, files: files.map((f) => `${f.name}:${f.size}`) }}
        submitLabel={isCreate ? (files.length > 1 ? `Upload ${files.length} documents` : "Upload") : "Save changes"}
        canSubmit={canSubmit}
        whyNot={whyNot}
        onSubmit={submit}
        className={cn(ackMode && "sm:max-w-5xl")}
      >
          {/* When placing an acknowledgement signature, split into two columns: the form on the left, the PDF
              placement on the right. Otherwise a single stacked column. */}
          <div className={cn(ackMode ? "flex flex-col gap-6 lg:flex-row" : "grid gap-4")}>
          <div className={cn("min-w-0", ackMode ? "flex flex-1 flex-col gap-4" : "contents")}>
          {isCreate && (
            <Field label={files.length > 1 ? `Files (${files.length})` : "File"} error={pickedNonPdf && form.requireAck ? "Acknowledgement needs a PDF." : undefined} eager>
              <FileDropField
                files={files}
                onFiles={onPickFiles}
                accept={ackMode ? "application/pdf,.pdf" : ACCEPT}
                hint={ackMode ? "PDF only - the signature is stamped onto it." : "PDF, document, sheet or image. Several files file as several documents."}
              />
            </Field>
          )}
          {/* A batch names each document after its own file - one title box can't name four documents. */}
          {isCreate && files.length > 1 ? (
            <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Each file is filed as its own document, titled from its file name ({stripExt(files[0]!.name)}, {stripExt(files[1]!.name)}
              {files.length > 2 ? `, +${files.length - 2} more` : ""}). Type, owner and expiry below apply to all of them.
            </p>
          ) : (
            <Field label="Title">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Code of conduct 2026" />
            </Field>
          )}
          {titleClash && (
            <p className="-mt-1 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
              <AlertCircle className="mr-1 inline h-3.5 w-3.5" />
              "{titleClash.display_name}" is already filed here{titleClash.requires_ack ? " and is being acknowledged" : ""} - two copies means two signature trails and two expiry dates.
            </p>
          )}
          <Field label="Belongs to" hint="Organization-wide, or a specific employee's file.">
            <Combobox
              value={form.employee}
              onValueChange={(v) => setForm({ ...form, employee: v })}
              searchPlaceholder="Search…"
              options={[{ value: ORG, label: "Organization" }, ...employees.filter((e) => !e.disabled).map((e) => ({ value: `employees/${idOf(e.path)}`, label: `${e.first_name} ${e.last_name}` }))]}
            />
          </Field>
          <FieldRow>
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
            <Field label="Expires (optional)" hint={expiryHint}>
              <Input type="date" value={form.expire} onChange={(e) => setForm({ ...form, expire: e.target.value })} />
            </Field>
          </FieldRow>
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
          {/* An unsigned document still leaves a trail: say how many people have opened it. */}
          {dialog?.kind === "edit" && !dialog.doc.requires_ack && <DocumentReadCount doc={dialog.doc} />}
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
            <Field
              label="Notify on publish"
              hint={
                form.audience === "none"
                  ? "Nobody is told; they find it on the Documents page."
                  : form.requireAck
                    ? `${form.audience === "everyone" ? activeCount : form.audienceEmployees.length} ${(form.audience === "everyone" ? activeCount : form.audienceEmployees.length) === 1 ? "person gets" : "people get"} an action item to review & sign.`
                    : `${form.audience === "everyone" ? activeCount : form.audienceEmployees.length} ${(form.audience === "everyone" ? activeCount : form.audienceEmployees.length) === 1 ? "person gets" : "people get"} an in-app notification.`
              }
            >
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
            <div className="flex min-h-0 flex-col lg:w-[52%] lg:shrink-0">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">Signature placement</span>
                <span className={cn("text-xs", form.signAnchor ? "text-muted-foreground" : "text-warning")}>
                  {form.signAnchor ? `Page ${form.signAnchor.page}` : "Not placed yet"}
                </span>
              </div>
              <div className="h-[52dvh] min-h-0 lg:h-[60dvh]">
                {ackPdfSrc ? (
                  <PdfSignaturePlacer src={ackPdfSrc} value={form.signAnchor} onChange={(b) => setForm({ ...form, signAnchor: b })} />
                ) : (
                  <p className="text-sm text-muted-foreground">{isCreate ? "Choose a PDF file to place the signature." : "Loading document…"}</p>
                )}
              </div>
            </div>
          )}
          </div>
      </WriteDialog>

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

      {/* Acknowledge (e-sign) a policy: read it in the dialog, then sign. */}
      <SignDocumentDialog
        doc={liveAckDoc}
        mode="acknowledge"
        me={myEmp}
        queue={ackQueue}
        onSelect={setAckDoc}
        onClose={() => setAckDoc(null)}
        onDone={reload} // the new signed copy + acknowledged state come back on reload
        onDownload={onDownload}
      />

      {/* In-app digital-signature viewer: verifies the embedded signature client-side and draws the
          valid/invalid/unknown stamp over the signature widget. The stored PDF is never modified. */}
      <Dialog open={!!viewerDoc} onOpenChange={(o) => !o && setViewerDoc(null)}>
        {/* A fixed 85vh from `sm` up (a document viewer wants a stable frame); on a phone the shared sheet
            geometry wins instead, so the panel yields height to the on-screen keyboard rather than sitting
            behind it. */}
        <DialogContent className="flex max-w-4xl flex-col sm:h-[85vh]">
          <DialogHeader><DialogTitle className="truncate pr-6">{viewerDoc?.display_name}</DialogTitle></DialogHeader>
          {viewerBytes
            ? <Suspense fallback={<PageSkeleton />}><SignedPdfViewer bytes={viewerBytes} /></Suspense>
            : <PageSkeleton />}
        </DialogContent>
      </Dialog>

      {/* Document activity: changes, sign/ack, downloads and sensitive reads for this document - and beneath
          it the whole document story, which is three records deep. "Was this policy signed, by whom, and when"
          reads as one question and lives across the policy, each acknowledgement, and the signed copy each one
          produced; the document's own trail is the first of those three. */}
      <Dialog open={!!activityDoc} onOpenChange={(o) => !o && setActivityDoc(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Activity</DialogTitle></DialogHeader>
          {activityDoc && <ActivityFeed resource={activityDoc.path} />}
          {activityDoc && <ActivitySection caseRoot={activityDoc.path} label="Acknowledgements and signed copies" className="border-t pt-3" />}
        </DialogContent>
      </Dialog>

      {/* Sign (e-sign) your own generated letter/contract in place */}
      <SignDocumentDialog
        doc={liveSignDoc}
        mode="sign"
        me={myEmp}
        queue={signQueue}
        onSelect={setSignDoc}
        onClose={() => setSignDoc(null)}
        onDone={reload}
        onDownload={onDownload}
      />

      {progressDoc && (
        <AckProgressDialog
          doc={progressDoc}
          employees={employees}
          departments={departments}
          onClose={() => setProgressDoc(null)}
        />
      )}
    </div>
  );
}

// Who has actually opened a document that nobody is required to sign.
//
// A policy with acknowledgement has a signature trail; an ordinary handbook or notice has nothing - HR publishes
// it and never learns whether it was read. The audit log has known all along (every download and sensitive read
// is recorded), so this reads that trail back as a count of distinct people. Lazy: one request, only when the
// edit dialog is open, and only for a caller who holds the activity grant.
function DocumentReadCount({ doc }: { doc: DocumentResource }) {
  const collection = docCollection(doc);
  const allowed = useCanSeeActivity(collection);
  const [readers, setReaders] = useState<{ people: number; last?: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    get<ActivityPage>(`activity?resource=${encodeURIComponent(doc.path)}&max_page_size=100`)
      .then((p) => {
        if (!live) return;
        const reads = (p.results ?? []).filter((a) => /download|read|preview/i.test(a.action));
        const people = new Set(reads.map((a) => a.actor ?? a.actor_email));
        setReaders({ people: people.size, last: reads[0]?.create_time });
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [allowed, doc.path]);

  if (!allowed || failed || !readers) return null;
  return (
    <p className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <Eye className="mr-1 inline h-3.5 w-3.5" />
      {readers.people === 0
        ? "Nobody has opened this document yet."
        : `${readers.people} ${readers.people === 1 ? "person has" : "people have"} opened this document${readers.last ? `, most recently ${formatDate(readers.last)}` : ""}.`}
      {" "}Reading is not a signature - turn on acknowledgement if you need one.
    </p>
  );
}

// How far the acknowledgement dialog follows the cursor. One row per employee per version, so this covers an
// org several times over; past it the notice in the dialog takes over.
const ACK_ROW_CAP = 5000;

// HR view: who has acknowledged the current version of a policy, and who's still pending. Pending is computed
// against active employees (an approximation of "everyone who can see it").
function AckProgressDialog({ doc, employees, departments, onClose }: { doc: DocumentResource; employees: Employee[]; departments: Department[]; onClose: () => void }) {
  const { toast } = useToast();
  const [acks, setAcks] = useState<DocumentAcknowledgement[]>([]);
  const [acksTruncated, setAcksTruncated] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    // THE CURSOR IS FOLLOWED. "Pending" here is computed by SUBTRACTING the signatures from the active roster,
    // so a short read does not show fewer signatures - it moves people who have already signed into the chase
    // list. This asked for 500 and the server caps a page at 100, so every org past a hundred acknowledgements
    // was being told to chase people who were done.
    getAllPages<DocumentAcknowledgement>(`document-acknowledgements?document=${encodeURIComponent(doc.path)}`, ACK_ROW_CAP)
      .then((r) => { if (live) { setAcks(r.results); setAcksTruncated(r.truncated); setLoaded(true); } })
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

  // Chasing signatures is the whole job of this dialog, so the pending side is searchable and its addresses
  // are one click from the mail client. There is no "remind" verb to call - the copy IS the chase-up.
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const match = (name: string) => !needle || name.toLowerCase().includes(needle);
  const shownSigned = current.filter((a) => {
    const e = employees.find((x) => idOf(x.path) === idOf(a.employee!));
    return match(e ? empName(e) : idOf(a.employee!));
  });
  const shownPending = pending.filter((e) => match(empName(e)));
  const pct = active.length ? Math.round((current.length / active.length) * 100) : 0;
  const [copied, setCopied] = useState(false);
  async function copyPending() {
    const emails = pending.map((e) => e.work_email).filter(Boolean).join(", ");
    try {
      await navigator.clipboard.writeText(emails);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable - the names are on screen */ }
  }

  // The chase-up itself. The daily job nudges at 3, 7 and 14 days; this is the same reminder on demand, for
  // everyone still outstanding or for one person. Gated on the verb the server will check anyway.
  const canRemind = (doc.access?.can ?? []).includes("remindAck");
  const [reminding, setReminding] = useState<string | null>(null); // employee path, or "*" for everyone
  async function remind(employee?: Employee) {
    setReminding(employee ? employee.path : "*");
    try {
      await invoke(doc.path, "remindAck", undefined, employee ? { employee: `employees/${idOf(employee.path)}` } : undefined);
      toast({
        title: employee ? `Reminded ${employee.first_name} ${employee.last_name}` : "Reminder sent",
        description: employee ? undefined : `${pending.length} ${pending.length === 1 ? "person" : "people"} still to sign.`,
        variant: "success",
      });
    } catch (e) {
      toast({ title: "Couldn't send the reminder", description: (e as Error).message, variant: "destructive" });
    } finally {
      setReminding(null);
    }
  }

  // Pending grouped by department: "Engineering is 4 short" is a conversation with one manager; a flat cloud of
  // forty names is not.
  const deptName = new Map(departments.map((d) => [idOf(d.path), d.display_name]));
  const pendingByDept = (() => {
    const groups = new Map<string, Employee[]>();
    for (const e of shownPending) {
      const key = e.department ? deptName.get(idOf(e.department)) ?? "Unassigned" : "No department";
      const list = groups.get(key) ?? [];
      list.push(e);
      groups.set(key, list);
    }
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  })();

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent scrollBody className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">Acknowledgements · {doc.display_name}</DialogTitle>
          <DialogDescription>Version {version}. Pending is measured against every active employee.</DialogDescription>
        </DialogHeader>
        <DialogBody>
        {!loaded ? (
          // Progress bar, then the two lists of names it summarises.
          <>
            <Skeleton className="h-12 w-full rounded-lg" />
            <TableSkeleton rows={4} cols={3} className="mt-4" />
          </>
        ) : (
          <div className="space-y-4">
            {/* Past the ceiling the subtraction below stops being trustworthy, and this dialog's whole output is
                that subtraction - so say it here rather than let the pending list read as fact. */}
            {acksTruncated && (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
                Showing the first {ACK_ROW_CAP.toLocaleString()} acknowledgements. Some people listed as pending may already have signed.
              </p>
            )}
            {/* One glance at how far this policy has got, before any names. */}
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="font-medium">{current.length} of {active.length} signed</span>
                <span className="text-muted-foreground tabular-nums">{pct}%</span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${pct}% of active employees have acknowledged`}
              >
                <div className={cn("h-full rounded-full", pct === 100 ? "bg-emerald-500" : "bg-primary")} style={{ width: `${pct}%` }} />
              </div>
            </div>

            {active.length > 8 && (
              <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name…" className="h-8" />
            )}

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> Signed ({current.length})</p>
                {current.some((a) => a.signed_document) && (
                  // Each signed copy is a personal-document fetched by its own `download` verb, so the offer
                  // belongs to a caller who holds it - tracking who signed is a separate grant from reading
                  // what they signed.
                  <AccessAction collection="personal-documents" verb="download" label="Signed copies">
                    <Button variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={() => downloadAllSigned(current)}>
                      <Download className="mr-1 h-3.5 w-3.5" /> Download all signed
                    </Button>
                  </AccessAction>
                )}
              </div>
              {current.length === 0 ? <p className="text-sm text-muted-foreground">No one yet.</p> : shownSigned.length === 0 ? <p className="text-sm text-muted-foreground">Nobody signed matches "{q}".</p> : (
                <div className="space-y-1">
                  {shownSigned.map((a) => {
                    const e = employees.find((x) => idOf(x.path) === idOf(a.employee!));
                    return (
                      <div key={a.path} className="flex items-center gap-2 rounded-md border p-2">
                        <PhotoAvatar employeeId={idOf(a.employee!)} name={e ? empName(e) : ""} photo={e?.photo} className="h-7 w-7" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{e ? empName(e) : idOf(a.employee!)}</p>
                          <p className="truncate text-xs text-muted-foreground">Signed "{a.signature}"{a.acknowledged_time ? ` · ${formatDate(a.acknowledged_time)}` : ""}</p>
                        </div>
                        {a.signed_document && (
                          <AccessAction collection="personal-documents" objectPath={a.signed_document} verb="download" label="Signed copy">
                            <Button variant="ghost" size="sm" className="shrink-0" onClick={() => downloadFile(a.signed_document!, signedName(e, a))}>
                              <Download className="mr-1 h-3.5 w-3.5" /> Signed copy
                            </Button>
                          </AccessAction>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div>
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" /> Pending ({pending.length})</p>
                <div className="flex flex-wrap items-center gap-1">
                  {pending.length > 0 && canRemind && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" loading={reminding === "*"} onClick={() => remind()}>
                      {reminding !== "*" && <BellRing className="mr-1 h-3.5 w-3.5" />} Remind everyone
                    </Button>
                  )}
                  {pending.some((e) => e.work_email) && (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={copyPending}>
                      <Copy className="mr-1 h-3.5 w-3.5" /> {copied ? "Copied" : "Copy emails"}
                    </Button>
                  )}
                </div>
              </div>
              {pending.length === 0 ? <p className="text-sm text-muted-foreground">Everyone has acknowledged.</p> : shownPending.length === 0 ? <p className="text-sm text-muted-foreground">Nobody pending matches "{q}".</p> : (
                <div className="space-y-2.5">
                  {pendingByDept.map(([dept, people]) => (
                    <div key={dept}>
                      <p className="mb-1 text-xs text-muted-foreground">{dept} <span className="tabular-nums">({people.length})</span></p>
                      <div className="flex flex-wrap gap-1.5">
                        {people.map((e) => (
                          <span key={e.path} className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-1 text-xs">
                            <PhotoAvatar employeeId={idOf(e.path)} name={empName(e)} photo={e.photo} className="h-4 w-4 text-[8px]" /> {empName(e)}
                            {canRemind && (
                              <button
                                type="button"
                                onClick={() => remind(e)}
                                disabled={reminding !== null}
                                title={`Remind ${empName(e)}`}
                                aria-label={`Remind ${empName(e)}`}
                                className="rounded-full p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                              >
                                <BellRing className="h-3 w-3" />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {canRemind && pending.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">Everyone pending is also nudged automatically 3, 7 and 14 days after this version landed.</p>
              )}
            </div>
          </div>
        )}
        </DialogBody>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
