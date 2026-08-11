import * as React from "react";
import { KeyRound } from "lucide-react";
import { create, remove } from "@/api";
import { usePermission } from "@/lib/perm";
import { ruleScopeFor, ruleMatchesTarget } from "./accessRuleScope";
import { type AccessRule, CELL, labelOf, fetchAllAccessRules, collectionsForRules, groupOf, COLLECTION_GROUPS, accessTone } from "./permMatrix";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
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
  const [filter, setFilter] = React.useState("");
  // Group the rows by module (curated order, "Other" last for live-rule extras), then filter by label.
  const grouped = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shown = q ? collections.filter((c) => labelOf(c).toLowerCase().includes(q) || c.includes(q)) : collections;
    const order = [...COLLECTION_GROUPS.map((g) => g.label), "Other"];
    const byGroup = new Map<string, string[]>();
    for (const c of shown) {
      const g = groupOf(c);
      byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
    }
    return order.filter((g) => byGroup.has(g)).map((g) => [g, byGroup.get(g)!] as const);
  }, [collections, filter]);
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

          {/* Coarse: collection-wide level per collection, grouped by module + filterable - the flat list
              outgrew scanning once the catalog covered every collection. */}
          <TabsContent value="coarse">
            <p className="mb-2 text-xs text-muted-foreground">Collection-wide access. Finer scope (own/department, fields, custom methods, single objects) is on the "All rules" tab and the in-context manage-access icons.</p>
            <Input className="mb-2 h-8" placeholder="Filter collections…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="max-h-[55vh] space-y-1 overflow-y-auto">
              {grouped.map(([group, cols]) => (
                <React.Fragment key={group}>
                  <p className="sticky top-0 z-10 bg-background px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
                  {cols.map((c) => {
                    const v = valueOf(c);
                    return (
                      <div key={c} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-accent/40">
                        <span className="text-sm font-medium">{labelOf(c)}</span>
                        {isGlobal || !canWrite ? (
                          <Badge variant={v === "deny" ? "destructive" : v === "none" ? "muted" : "secondary"} className={v === "deny" || v === "none" ? undefined : accessTone(v).text}>{v}</Badge>
                        ) : (
                          <Select value={v} onValueChange={(nv) => setCell(c, nv)} disabled={busy}>
                            {/* line-clamp-none + flex: the default value slot is a -webkit-box, which breaks the dot+label row. */}
                            <SelectTrigger className="h-8 w-32 shrink-0 [&>span]:flex [&>span]:items-center [&>span]:line-clamp-none"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {/* Coloured dot + label per level (same tones as the ACL modal) - a column of grey
                                  words is unreadable at a glance across ~60 collections. */}
                              {CELL.map((l) => <SelectItem key={l} value={l}><CellOption value={l} /></SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
              {grouped.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No collection matches "{filter}".</p>}
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

// One level option: coloured dot + coloured label. Radix clones the selected item's children into the trigger,
// so this styles the closed control too.
function CellOption({ value }: { value: string }) {
  const tone = accessTone(value);
  return (
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap font-medium", tone.text)}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot)} />
      {value}
    </span>
  );
}
