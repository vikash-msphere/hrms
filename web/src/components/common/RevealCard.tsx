import { useState, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AccessTarget } from "@/components/access/AccessTarget";
import type { AccessTargetRef } from "@/components/access/AccessModeProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// A card that holds its place without reading anything, and mounts what it wraps on a press.
//
// This exists for the audit trail, not for the layout. Reading somebody else's bank account or tax details is
// a `sensitive_subresources` surface (domain/manifests.ts AUDIT), so every GET of one writes an
// `employees.read.sensitive` row naming the admin who read it. While each of those panels had a tab to
// itself, that row carried an intent: opening the tab WAS going to look. Sharing a tab with another panel
// takes the intent away - the fetch, and the row, now fire because a neighbouring section was opened. A
// reviewer asking "who went looking at this person's account number" gets back everyone who happened to open
// Identity.
//
// Unmounting is the mechanism, deliberately: the wrapped panel fetches on mount, so not rendering it is the
// only way to be sure nothing is read. A prop the panel checks would leave the request one refactor away from
// firing again. The second effect is the one `d1-read-minimization` asks for - a D1 read and a decrypt that
// nobody wanted do not happen at all.
//
// `defaultOpen` is for the surfaces where none of the above applies: reading your OWN sensitive data is never
// audited (domain/auditAccess.ts - "not an abuse signal"), so a person on their own record gets the panel
// open, as it was.
export function RevealCard({
  title,
  icon,
  hint,
  action = "Show",
  defaultOpen = false,
  target,
  children,
}: {
  title: string;
  icon?: ReactNode;
  /** Why it is closed, in the reader's terms. Shown beside the button. */
  hint?: string;
  action?: string;
  defaultOpen?: boolean;
  /**
   * The grant this panel is behind, so the closed card still carries its manage-access key. Needed because the
   * wrapped panel - which owns that key - is NOT MOUNTED while this is closed: an access admin looking at a
   * colleague's Identity or Compensation tab would have found only the tab's own key, which names a different
   * grant (`employees` identity vs the bank sub-resource, `compensation` vs `employees.tax`), and granted the
   * wrong one. Omit it where the wrapped panel is not itself a grantable surface.
   */
  target?: AccessTargetRef;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // The real panel, unwrapped: once it is open this component is out of the way entirely, so the section looks
  // and behaves exactly as it does everywhere it is mounted directly.
  if (open) return <>{children}</>;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">
          <span className="flex items-center gap-2">
            {icon} {title}
            {target && <AccessTarget target={target} />}
          </span>
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Eye className="h-4 w-4" /> {action}
        </Button>
      </CardHeader>
      {hint && (
        <CardContent>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </CardContent>
      )}
    </Card>
  );
}
