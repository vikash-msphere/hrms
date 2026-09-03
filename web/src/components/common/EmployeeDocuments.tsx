import { useMemo } from "react";
import { FileText, FileLock, CheckCircle2, AlertCircle } from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, humanize, idOf } from "@/lib/utils";
import type { DocumentResource } from "@/types";
import { DocumentDownload } from "@/components/common/DocumentDownload";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessTarget } from "@/components/access/AccessTarget";
import { useToast } from "@/components/ui/use-toast";

/** Lists the documents tied to one employee. The server only returns documents the
 *  caller is allowed to see (owner + HR + super_admin for employee files). */
export function EmployeeDocuments({ employeeId, title = "Documents" }: { employeeId: string; title?: string }) {
  // Personal (employee-owned) documents; the server scopes the list to what the caller may see, and we
  // narrow to this employee. Org-wide documents live on the Documents page, not the profile.
  const { rows } = useCollection<DocumentResource>("personal-documents");
  const { toast } = useToast();

  const docs = useMemo(
    () => rows.filter((d) => d.employee && idOf(d.employee) === employeeId),
    [rows, employeeId]
  );

  // Form 16 precedence: for each financial year that has an OFFICIAL (TRACES) copy, the HRMS-generated copy is
  // superseded (still listed, but marked - the official one is the one to file). Built once per doc set.
  const officialFys = useMemo(
    () => new Set(docs.filter((d) => d.document_type === "FORM16" && d.official && d.financial_year).map((d) => d.financial_year)),
    [docs]
  );

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">
          <AccessAction collection="personal-documents" label={title}>
            <span className="flex items-center gap-2"><FileLock className="h-4 w-4 text-primary" /> {title}</span>
          </AccessAction>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {docs.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No documents on file.</p>
        ) : (
          <div className="divide-y">
            {docs.map((d) => {
              const isForm16 = d.document_type === "FORM16";
              const superseded = isForm16 && !d.official && !!d.financial_year && officialFys.has(d.financial_year);
              // The status badges and Download together want ~300px, which is a whole phone screen next to a
              // document name. Below `sm` they take a line of their own under the name instead of squeezing
              // it to nothing.
              return (
              <div key={d.path} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                    <FileText className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <p className={`truncate text-sm font-medium ${superseded ? "text-muted-foreground" : ""}`}>{d.display_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {d.file_name ?? "No file"}
                      {d.expire_time ? ` · expires ${formatDate(d.expire_time)}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-12 sm:shrink-0 sm:pl-0">
                  {isForm16 ? (
                    d.official ? (
                      <Badge variant="success">Official · TRACES</Badge>
                    ) : superseded ? (
                      <Badge variant="muted">Superseded</Badge>
                    ) : (
                      <Badge variant="secondary">HRMS-generated</Badge>
                    )
                  ) : (
                    <Badge variant="secondary">{humanize(d.document_type)}</Badge>
                  )}
                  {/* Generated letters/contracts awaiting the owner's e-signature (signed on the Documents page). */}
                  {d.requires_signature ? (
                    d.signed_time ? (
                      <Badge variant="success" className="gap-1"><CheckCircle2 className="h-3 w-3" /> Signed {formatDate(d.signed_time)}</Badge>
                    ) : (
                      <Badge variant="warning" className="gap-1"><AlertCircle className="h-3 w-3" /> Awaiting signature</Badge>
                    )
                  ) : null}
                  {/* One control: a plain Download, or a two-item menu when this document's letterhead has a
                      print version to offer as well. */}
                  {d.size_bytes ? (
                    <AccessAction collection={d.path.split("/")[0]} objectPath={d.path} can={d.access?.can} verb="download" label="Download">
                      <DocumentDownload doc={d} />
                    </AccessAction>
                  ) : null}
                  {/* Object-level access for THIS document: who can read/write/admin it (the "control access per
                      document" affordance). Bare key icon, shown only in access-management mode. */}
                  <AccessTarget target={{ collection: d.path.split("/")[0], objectPath: d.path, label: d.display_name, can: d.access?.can }} />
                </div>
              </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
