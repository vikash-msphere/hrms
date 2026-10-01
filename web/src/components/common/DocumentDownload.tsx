import * as React from "react";
import { ChevronDown, Download, Loader2, Monitor, Printer } from "lucide-react";
import { download } from "@/api";
import { documentFileName } from "@/lib/documents";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import type { DocumentResource } from "@/types";
import { cn } from "@/lib/utils";

// Downloading a document, in the one place that knows how.
//
// A document has one version or two. Most have one - the letterhead they were issued on has no print version,
// or they were uploaded rather than laid out here - and for those this is a plain Download button, because a
// menu offering one thing is a menu that wastes a click. When the letterhead DOES have a print version
// (`print_variant` on the row), the same button becomes a two-item menu: the filed document, or the same
// document re-rendered on the print page.
//
// The distinction is data, not a guess: it is decided server-side from the letterhead the document was
// actually rendered on. Before this, every letter and Form 16 carried a permanent second "Print copy" action
// whether or not there was a print page to render on - which is how you end up with a button that does
// nothing different.

/** Whether a document can be downloaded at all, and whether it has a second version. */
export const canDownload = (d: DocumentResource) => !!d.size_bytes;
// `print_variant` alone - no second guess about document types here. The server sets it only for a document
// it rendered on a letterhead that has a print version, so it already means exactly "there are two of these",
// and a new kind of generated document gets the choice without this file learning its name.
const hasPrint = (d: DocumentResource) => !!d.print_variant;

/** Filenames for the two versions, so a saved print copy is not mistaken for the filed one. */
const screenName = (d: DocumentResource) => documentFileName(d);
const printName = (d: DocumentResource) => documentFileName(d).replace(/\.pdf$/i, "") + " (print).pdf";

/** Shared by the button and the menu items, so both fail the same way. */
export function useDocumentDownload() {
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const run = React.useCallback(
    async (d: DocumentResource, variant: "screen" | "print") => {
      setBusy(true);
      try {
        if (variant === "print") await download(d.path, printName(d), { verb: "print" });
        else await download(d.path, screenName(d));
      } catch (e) {
        toast({
          title: variant === "print" ? "Couldn't make a print copy" : "Download failed",
          description: (e as Error).message,
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [toast]
  );
  return { run, busy };
}

export function DocumentDownload({
  doc,
  size = "sm",
  variant = "outline",
  className,
}: {
  doc: DocumentResource;
  size?: "sm" | "default";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const { run, busy } = useDocumentDownload();
  const icon = busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />;

  if (!hasPrint(doc)) {
    return (
      <Button variant={variant} size={size} className={className} disabled={busy} onClick={() => run(doc, "screen")}>
        {icon} Download
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} className={cn("gap-1", className)} disabled={busy}>
          {icon} Download <ChevronDown className="h-3.5 w-3.5 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void run(doc, "screen")}>
          <Monitor className="h-4 w-4" /> Screen version
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void run(doc, "print")}>
          <Printer className="h-4 w-4" /> Print version
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same choice as row-menu entries, for a table that already has an actions menu of its own. */
export function documentDownloadItems(doc: DocumentResource, run: (d: DocumentResource, v: "screen" | "print") => void) {
  if (!canDownload(doc)) return [];
  if (!hasPrint(doc)) return [{ label: "Download", icon: <Download className="h-4 w-4" />, onClick: () => run(doc, "screen") }];
  return [
    { label: "Download (screen)", icon: <Monitor className="h-4 w-4" />, onClick: () => run(doc, "screen") },
    { label: "Download (print)", icon: <Printer className="h-4 w-4" />, onClick: () => run(doc, "print") },
  ];
}
