import { useCallback, useEffect, useState } from "react";
import { list, create as apiCreate } from "@/api";
import type { DocumentResource } from "@/types";
import type { LoadState } from "@/hooks/useCollection";

// The backend splits documents into two resources gated separately by the authz middleware: org-documents
// (flat, company-wide) and personal-documents (employee-owned). The UI presents them as one "Documents"
// list, so this facade fans list reads out to both and routes writes by ownership. The collection a row
// belongs to is recoverable from its own `path` (e.g. "personal-documents/abc"), so per-row actions never
// need a separately-tracked collection.
export type DocCollection = "org-documents" | "personal-documents";

export function docCollection(d: Pick<DocumentResource, "path" | "employee">): DocCollection {
  const head = d.path?.split("/")[0];
  if (head === "org-documents" || head === "personal-documents") return head;
  return d.employee ? "personal-documents" : "org-documents";
}

// Extension implied by a stored content type, for rows the app generated rather than someone uploading
// (letters, signed policy copies) - those carry no file_name.
const EXT_BY_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

// The name to save a document under. Falls back to the display name when there is no uploaded file name, and
// always appends the extension the content type implies - otherwise generated/signed PDFs save extensionless.
export function documentFileName(d: Pick<DocumentResource, "file_name" | "display_name" | "content_type">): string {
  const ext = EXT_BY_TYPE[(d.content_type ?? "").toLowerCase().split(";")[0]!.trim()];
  const base = (d.file_name || d.display_name || "document").replace(/[/\\]/g, "-").trim();
  const hasExt = /\.[a-z0-9]{1,5}$/i.test(base);
  return hasExt || !ext ? base : `${base}.${ext}`;
}

export type DocumentBody = {
  display_name: string;
  document_type: string;
  employee?: string | null;
  expire_time?: string | null;
  published?: boolean; // create as a draft (false) instead of the published default
};

// Create routes to personal-documents when an employee owner is given, else org-documents. The `employee`
// key is only sent for personal docs (org-documents ignores it, but keeping the body clean avoids surprises).
export function createDocument(body: DocumentBody) {
  if (body.employee) return apiCreate<DocumentResource>("personal-documents", body);
  const { employee: _omit, ...rest } = body;
  void _omit;
  return apiCreate<DocumentResource>("org-documents", rest);
}

// Merged list of both document resources, newest first. Each side is fetched independently so a permission
// difference on one resource (e.g. an employee who can read only their own personal docs) still yields the
// rows they can see from the other.
export function useDocuments(opts: { showDeleted?: boolean } = {}) {
  const { showDeleted = false } = opts;
  const [rows, setRows] = useState<DocumentResource[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setState("loading");
      const [org, personal] = await Promise.all([
        list<DocumentResource>("org-documents", { showDeleted }).then((r) => r.results ?? []).catch(() => [] as DocumentResource[]),
        list<DocumentResource>("personal-documents", { showDeleted }).then((r) => r.results ?? []).catch(() => [] as DocumentResource[]),
      ]);
      const merged = [...org, ...personal].sort((a, b) => (b.create_time ?? "").localeCompare(a.create_time ?? ""));
      setRows(merged);
      setState("ready");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  }, [showDeleted]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { rows, setRows, state, error, reload };
}
