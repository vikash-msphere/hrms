import * as React from "react";
import { KeyRound } from "lucide-react";
import { create, remove } from "@/api";
import { usePermission } from "@/lib/perm";
import { ruleScopeFor, ruleMatchesTarget } from "./accessRuleScope";
import { type AccessRule, CELL, labelOf, fetchAllAccessRules, collectionsForRules } from "./permMatrix";
import { FineRulesEditor } from "./FineRulesEditor";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

// View + modify ALL of one subject's (a role or a user) collection-wide permissions in one place. Each row is
// a collection; the dropdown sets the subject's org-scope level (none/read/write/admin/deny) via the same
// access-rules API the matrix and ACL modal use. Finer scope (own/dept, fields, custom methods, single
// objects) stays with the manage-access icons. For a user these are exceptions layered on their role.
export function SubjectPermissionsDialog({
  open,
  onClose,
  subjectKind,
  subject,
  label,
}: {
  open: boolean;
  onClose: () => void;
  subjectKind: "role" | "user";
  subject: string; // role name, or users/<id>
  label: string;
}) {
  const { toast } = useToast();
  const canWrite = usePermission("access-rules.write");
  const [rules, setRules] = React.useState<AccessRule[]>([]);
  const [busy, setBusy] = React.useState(false);

  const reload = React.useCallback(async () => {
    setBusy(true);
    try {
      setRules(await fetchAllAccessRules());
    } catch (e) {
      toast({ variant: "destructive", title: "Could not load permissions", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }, [toast]);
  React.useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const mine = rules.filter((r) => r.subject_kind === subjectKind && r.subject === subject);
  const collections = collectionsForRules(mine);
  const isGlobal = mine.some((r) => (r.collection === "*" || r.collection === "**") && !r.field && !r.verb && r.effect === "allow");

  const cellRules = (collection: string) => mine.filter((r) => !r.verb && ruleMatchesTarget(r, { collection }));
  const valueOf = (collection: string): string => {
    if (isGlobal) return "admin";
    const rs = cellRules(collection);
    if (rs.some((r) => r.effect === "deny")) return "deny";
    return rs.find((r) => r.effect === "allow")?.level ?? "none";
  };

  async function setCell(collection: string, value: string) {
    setBusy(true);
    try {
      for (const r of cellRules(collection)) await remove(r.path, r.etag); // edit = delete + create
      if (value !== "none") {
        const body = value === "deny" ? { effect: "deny" } : { level: value };
        await create("access-rules", { subject_kind: subjectKind, subject, collection, ...ruleScopeFor({ collection }), ...body });
      }
      toast({ title: `Updated ${labelOf(collection)}` });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not update", description: String((e as Error).message) });
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-600 dark:text-amber-400" /> Permissions · {label}
          </DialogTitle>
          <DialogDescription>
            {subjectKind === "user" ? "Per-user access (exceptions layered on the user's role)." : "Access for this role."} A deny always wins.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="coarse">
          <TabsList>
            <TabsTrigger value="coarse">By collection</TabsTrigger>
            <TabsTrigger value="fine">All rules</TabsTrigger>
          </TabsList>

          {/* Coarse: collection-wide level per collection. */}
          <TabsContent value="coarse">
            <p className="mb-2 text-xs text-muted-foreground">Collection-wide access. Finer scope (own/department, fields, custom methods, single objects) is on the "All rules" tab and the in-context manage-access icons.</p>
            <div className="max-h-[55vh] space-y-1 overflow-y-auto">
              {collections.map((c) => {
                const v = valueOf(c);
                return (
                  <div key={c} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-accent/40">
                    <span className="text-sm font-medium">{labelOf(c)}</span>
                    {isGlobal || !canWrite ? (
                      <Badge variant={v === "deny" ? "destructive" : v === "none" ? "muted" : "secondary"}>{v}</Badge>
                    ) : (
                      <Select value={v} onValueChange={(nv) => setCell(c, nv)} disabled={busy}>
                        <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {CELL.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                );
              })}
            </div>
          </TabsContent>

          {/* Fine: every assigned rule (any scope/field/verb) + add. */}
          <TabsContent value="fine">
            <FineRulesEditor rules={mine} reload={reload} fixedSubject={{ kind: subjectKind, subject }} canWrite={canWrite} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
