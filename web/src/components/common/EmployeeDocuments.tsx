import { useMemo, useState } from "react";
import { FileText, FileLock, CheckCircle2, AlertCircle, Search } from "lucide-react";
import { useCollection } from "@/hooks/useCollection";
import { formatDate, humanize } from "@/lib/utils";
import type { DocumentResource } from "@/types";
import { DocumentDownload } from "@/components/common/DocumentDownload";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AccessAction } from "@/components/access/AccessAction";
import { AccessTarget } from "@/components/access/AccessTarget";
import { useToast } from "@/components/ui/use-toast";

const ALL = "__all__";
// From how many documents the search + type filters are worth their own row of chrome.
const FILTER_FROM = 4;

/** Lists the documents tied to one employee. The server only returns documents the
 *  caller is allowed to see (owner + HR + super_admin for employee files). */
export function EmployeeDocuments({ employeeId, title = "Documents" }: { employeeId: string; title?: string }) {
  // THIS PERSON'S documents, asked for as such (`?employee=`, which documentRoutes takes and every sibling
  // profile panel already passes). Reading the collection and filtering here looked equivalent and is not: the
  // server scope is an AUTHZ scope, not a per-employee one, so for the employee themselves it coincides and
  // for HR it is the whole org - a hundred newest personal-documents across everybody, of which this person's
  // may be none. The card then renders "No documents on file" over a shelf that is not empty, and `officialFys`
  // below stops marking a generated Form 16 as superseded because the official copy fell off the page.
  //
  // `all`, because a long-tenured employee's own file can itself pass a page and this is a file rather than a
  // feed - there is no "load more" on it. It also stops the profile pulling other people's identity scans and
  // contracts into the browser, on the one collection instrument.ts singles out by name.
  const { rows: docs } = useCollection<DocumentResource>("personal-documents", {
    all: true,
    params: { employee: `employees/${employeeId}` },
  });
  const { toast } = useToast();

  // Form 16 precedence: for each financial year that has an OFFICIAL (TRACES) copy, the HRMS-generated copy is
  // superseded (still listed, but marked - the official one is the one to file). Built from the WHOLE set
  // rather than from what the filters leave on screen: precedence is a fact about the person's file, so a
  // search for "form 16" that happens to exclude the official copy must not turn the generated one back into
  // the copy to file.
  const officialFys = useMemo(
    () => new Set(docs.filter((d) => d.document_type === "FORM16" && d.official && d.financial_year).map((d) => d.financial_year)),
    [docs]
  );

  // Finding one document in a file that has grown. Client-side, over rows already in hand (`all` above), so
  // typing costs no request and the filters can be crossed freely.
  const [query, setQuery] = useState("");
  const [type, setType] = useState(ALL);
  // Only the types this person actually has. A picker offering CONTRACT to somebody with none is a filter
  // whose every use is a dead end.
  const types = useMemo(
    () => [...new Set(docs.map((d) => d.document_type).filter(Boolean))].sort(),
    [docs]
  );
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return docs.filter((d) => {
      if (type !== ALL && d.document_type !== type) return false;
      if (!needle) return true;
      // What the reader can SEE on the row, which is what they are typing from: its name, the file it came as,
      // the type badge in words, and the year a Form 16 or a payslip is for.
      return [d.display_name, d.file_name, humanize(d.document_type ?? ""), d.financial_year]
        .some((v) => v?.toLowerCase().includes(needle));
    });
  }, [docs, query, type]);
  // A toolbar over four rows is furniture. It appears when the file is long enough to be worth searching.
  const filterable = docs.length > FILTER_FROM;
  const filtered = query.trim() !== "" || type !== ALL;

  return (
    // `sentry-mask` on the whole card. This reads the SAME collection (`personal-documents`) that
    // `SENSITIVE_PAGES` masks the Documents route for - "scanned identity documents, contracts, insurance
    // cards" - but renders on /profile and /employees/<id>, neither of which is on that list, and the
    // posture is unmask-by-default. Without this, document names, types (FORM16, insurance, identity),
    // financial years and expiry dates went to Sentry in full, and "Report a problem" attaches the recording
    // to a ticket. It is the eighth panel on the profile; the other seven are tagged and pinned by
    // test/replayMaskCoverage.test.ts.
    <Card className="mt-6 sentry-mask">
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base">
          <AccessAction collection="personal-documents" label={title}>
            <span className="flex items-center gap-2"><FileLock className="h-4 w-4 text-primary" /> {title}</span>
          </AccessAction>
        </CardTitle>
        {filterable && (
          /* `aria-label="Search"`, not "Search documents": the tab this card sits on is labelled "Documents",
             and getByLabel matches on a substring, so a second control carrying that word makes every test
             that reaches for the panel ambiguous. The placeholder still says which documents. */
          <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
            <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search documents…"
                className="h-9 w-full pl-8"
              />
            </div>
            {types.length > 1 && (
              <Select value={type} onValueChange={setType}>
                <SelectTrigger aria-label="Filter by type" className="h-9 w-[9.5rem] shrink-0"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All types</SelectItem>
                  {types.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {docs.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No documents on file.</p>
        ) : shown.length === 0 ? (
          /* The file is not empty - the filters are. Said as such, with the way back, because "No documents on
             file" here would read as a record that has lost its documents. */
          <div className="py-4 text-center">
            <p className="text-sm text-muted-foreground">No documents match.</p>
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => { setQuery(""); setType(ALL); }}>Clear filters</Button>
          </div>
        ) : (
          <>
          {/* How much of the file is being hidden, so a row somebody expected and cannot see reads as a filter
              rather than as a missing document. */}
          {filtered && <p className="pb-2 text-xs text-muted-foreground">Showing {shown.length} of {docs.length}.</p>}
          <div className="divide-y">
            {shown.map((d) => {
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
