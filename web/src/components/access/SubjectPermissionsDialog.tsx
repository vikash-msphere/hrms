import * as React from "react";
import { KeyRound } from "lucide-react";
import { create, invoke, remove } from "@/api";
import { usePermission } from "@/lib/perm";
import { ruleScopeFor, ruleMatchesTarget } from "./accessRuleScope";
import { type AccessRule, CELL, labelOf, fetchAllAccessRules, collectionsForRules, groupOf, COLLECTION_GROUPS, accessTone } from "./permMatrix";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { roleLabel } from "@/lib/roles";
import { CellOption } from "./CellOption";
import { AccessAction } from "./AccessAction";
import { ruleSentence } from "./ruleLogic";
import { restoreAccessRules } from "./cloneRules";
import { FineRulesEditor } from "./FineRulesEditor";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";

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
  viaRole,
}: {
  open: boolean;
  onClose: () => void;
  subjectKind: "role" | "user";
  subject: string; // role name, or users/<id>
  label: string;
  /** The user's role, for a user subject. Every row then says what the role already gives, so these rows read
   *  as the exceptions they are: "none" on a user who inherits write from their role is not no access. */
  viaRole?: string;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const canWrite = usePermission("access-rules.write");
  const [rules, setRules] = React.useState<AccessRule[]>([]);
  const [busy, setBusy] = React.useState(false);
  // The level a cell is being MOVED to, per collection, while its write is in flight.
  //
  // Setting a level is delete-then-create followed by a re-fetch of every access rule in the org, so the
  // truth this dialog reads from is a second or more behind the press. Without this the dropdown snapped back
  // to the old level for that whole window - the level you just chose, shown as not chosen - and one shared
  // `busy` flag disabled all sixty rows while it happened, so the obvious response (press it again) was also
  // impossible. Only the row being written is frozen now, and it shows what it is being set to.
  const [saving, setSaving] = React.useState<Record<string, string>>({});

  const reload = React.useCallback(async () => {
    setBusy(true);
    try {
      // The subject's own rules, and the role a user subject holds - the only two this dialog reads, rather
      // than paging through every rule in the org to filter down to them.
      const [own, inherited] = await Promise.all([
        fetchAllAccessRules({ subject_kind: subjectKind, subject }),
        viaRole ? fetchAllAccessRules({ subject_kind: "role", subject: viaRole }) : Promise.resolve([]),
      ]);
      setRules([...own, ...inherited]);
    } catch (e) {
      toast({ variant: "destructive", title: "Could not load permissions", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }, [toast, subjectKind, subject, viaRole]);
  React.useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const mine = rules.filter((r) => r.subject_kind === subjectKind && r.subject === subject);
  const collections = collectionsForRules(mine);
  const [filter, setFilter] = React.useState("");
  // Sixty rows of which four say anything is a haystack. This hides the "none" rows, so the answer to "what
  // does this role actually have?" is the whole list rather than something to scroll for.
  const [onlyGranted, setOnlyGranted] = React.useState(false);
  const isGlobal = mine.some((r) => (r.collection === "*" || r.collection === "**") && !r.field && !r.verb && r.effect === "allow");

  const cellRules = (collection: string) => mine.filter((r) => !r.verb && ruleMatchesTarget(r, { collection }));
  const valueOf = (collection: string): string => {
    if (isGlobal) return "admin";
    const rs = cellRules(collection);
    if (rs.some((r) => r.effect === "deny")) return "deny";
    return rs.find((r) => r.effect === "allow")?.level ?? "none";
  };

  // What the user's ROLE gives on a collection, for the inherited-level note beside each row. A user with no
  // rule of their own is not without access - they have whatever the role has, and saying "none" without that
  // context is how a per-user exception gets added to undo something that was never there.
  const roleRules = viaRole ? rules.filter((r) => r.subject_kind === "role" && r.subject === viaRole) : [];
  const roleGlobal = roleRules.some((r) => (r.collection === "*" || r.collection === "**") && !r.field && !r.verb && r.effect === "allow");
  const roleValueOf = (collection: string): string => {
    if (!viaRole) return "none";
    if (roleGlobal) return "admin";
    const rs = roleRules.filter((r) => !r.verb && ruleMatchesTarget(r, { collection }));
    if (rs.some((r) => r.effect === "deny")) return "deny";
    return rs.find((r) => r.effect === "allow")?.level ?? "none";
  };

  // Group the rows by module (curated order, "Other" last for live-rule extras), then filter by label.
  const grouped = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    let shown = q ? collections.filter((c) => labelOf(c).toLowerCase().includes(q) || c.includes(q)) : collections;
    if (onlyGranted && !isGlobal) shown = shown.filter((c) => valueOf(c) !== "none");
    const order = [...COLLECTION_GROUPS.map((g) => g.label), "Other"];
    const byGroup = new Map<string, string[]>();
    for (const c of shown) {
      const g = groupOf(c);
      byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
    }
    return order.filter((g) => byGroup.has(g)).map((g) => [g, byGroup.get(g)!] as const);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections, filter, onlyGranted, isGlobal, rules]);

  // The whole subject in one line, above the list: what they hold, before anybody scrolls for it.
  const tally = collections.reduce<Record<string, number>>((acc, c) => {
    const v = valueOf(c);
    if (v !== "none") acc[v] = (acc[v] ?? 0) + 1;
    return acc;
  }, {});
  const summary = isGlobal
    ? "Admin on everything (an org-wide rule)."
    : Object.keys(tally).length === 0
      ? subjectKind === "user"
        ? "No per-user rules. Everything this person can do comes from their role."
        : "No access anywhere. This role grants nothing until something is set below."
      : ["admin", "write", "read", "deny"]
          .filter((l) => tally[l])
          .map((l) => `${tally[l]} ${l === "deny" ? "denied" : l}`)
          .join(" · ");

  // Everything this subject has waiting on a second approver. Four-eyes queues a grant as `pending` and a
  // removal as `pending_delete`, and until now that queue was visible only on the permissions matrix and the
  // per-object key icon - so somebody editing this dialog could re-add a grant that was already queued, or
  // read a row as "no access" when its removal had simply not been approved yet.
  const pending = mine.filter((r) => r.status === "pending" || r.status === "pending_delete");

  async function decide(r: AccessRule, decision: "approve" | "reject") {
    // A pending rule can be either of the two directions setCell below stops for - taking access away, or
    // handing out admin - so approving it gets the same beat of friction, named by the rule itself.
    if (!(await confirmDecision(confirm, decision, ruleSentence(r, label)))) return;
    setBusy(true);
    try {
      await invoke("access-rules", decision, undefined, { rule: r.path });
      toast({ title: decision === "approve" ? "Change approved" : "Change rejected", variant: "success" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: `Could not ${decision}`, description: String((e as Error).message) });
      setBusy(false);
    }
  }

  async function setCell(collection: string, value: string) {
    // Two directions of this dropdown are worth stopping for: taking access away (people lose a page they were
    // using, and nothing tells them why) and handing out admin (the widest thing this dialog can do). Ordinary
    // read/write adjustments pass straight through - a confirm on every cell of a permission matrix is the
    // fastest way to teach someone to dismiss confirms without reading them.
    const from = valueOf(collection);
    const removing = (value === "none" || value === "deny") && from !== "none";
    if (removing || value === "admin") {
      const ok = await confirm({
        title: value === "admin" ? `Give ${label} admin on ${labelOf(collection)}?` : `Take away ${label}'s access to ${labelOf(collection)}?`,
        description: value === "admin"
          ? "Admin covers every action on that collection, including the destructive ones."
          : `They currently have ${from}. ${value === "deny" ? "A deny also overrides access they get from any role." : "Access they get from a role stays; this only removes what was granted here."}`,
        confirmLabel: value === "admin" ? "Give admin" : "Remove access",
        destructive: removing,
      });
      if (!ok) return;
    }
    setSaving((s) => ({ ...s, [collection]: value }));
    // Delete-then-create, and the same two consequences the matrix guards (see PermissionsPanel#setCell): the
    // deletes are committed even when the create fails, so the rules are put back rather than silently lost,
    // and the reload happens on EVERY path so this dialog can never keep showing a level the server no longer
    // holds.
    const removed: AccessRule[] = [];
    try {
      for (const r of cellRules(collection)) {
        await remove(r.path, r.etag);
        removed.push(r);
      }
      if (value !== "none") {
        const body = value === "deny" ? { effect: "deny" } : { level: value };
        await create("access-rules", { subject_kind: subjectKind, subject, collection, ...ruleScopeFor({ collection }), ...body });
      }
      toast({ title: `Updated ${labelOf(collection)}` });
    } catch (e) {
      const outstanding = removed.length - (await restoreAccessRules(removed));
      toast({
        variant: "destructive",
        title: "Could not update",
        description: outstanding
          ? `${String((e as Error).message)} - and ${outstanding} rule${outstanding === 1 ? "" : "s"} that had to be removed first could not be put back. Check ${labelOf(collection)} before relying on it.`
          : String((e as Error).message),
      });
    }
    try {
      await reload();
    } finally {
      // Cleared in the same tick the reload's rules land in, so the cell moves straight from the level it was
      // being set to to the level the server confirms - and falls back to the old one if the write failed.
      setSaving((s) => {
        const next = { ...s };
        delete next[collection];
        return next;
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* The 85vh ceiling starts at `sm`: on a phone the shared bottom-sheet height (which yields to the
          on-screen keyboard) has to win - see ui/dialog.tsx. */}
      <DialogContent className="flex max-w-3xl flex-col overflow-y-auto sm:max-h-[85vh] lg:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-600 dark:text-amber-400" /> Permissions · {label}
          </DialogTitle>
          <DialogDescription>
            {subjectKind === "user" ? "Per-user access (exceptions layered on the user's role)." : "Access for this role."} A deny always wins.
          </DialogDescription>
        </DialogHeader>
        {pending.length > 0 && (
          <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50/60 p-2.5 dark:border-amber-800 dark:bg-amber-950/30">
            <p className="text-xs font-medium">
              {pending.length} change{pending.length === 1 ? "" : "s"} waiting for a second approver. A queued grant does nothing yet; a queued removal is still in force.
            </p>
            {pending.map((r) => (
              <div key={r.path} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="min-w-0">
                  <Badge variant="secondary" className="mr-2 text-amber-700 dark:text-amber-400">{r.status === "pending" ? "new grant" : "removal"}</Badge>
                  {ruleSentence(r, label)}
                </span>
                {canWrite && (
                  // Deciding is its own grantable method, so each button carries its verb: an org can hand out
                  // "approve permission changes" without handing out the write that queues them.
                  <span className="flex gap-1">
                    <AccessAction verb="approve" collection="access-rules" label="Approve permission changes">
                      <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => void decide(r, "approve")}>Approve</Button>
                    </AccessAction>
                    <AccessAction verb="reject" collection="access-rules" label="Reject permission changes">
                      <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy} onClick={() => void decide(r, "reject")}>Reject</Button>
                    </AccessAction>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <Tabs defaultValue="coarse">
          <TabsList>
            <TabsTrigger value="coarse">By collection</TabsTrigger>
            <TabsTrigger value="fine">All rules</TabsTrigger>
          </TabsList>

          {/* Coarse: collection-wide level per collection, grouped by module + filterable - the flat list
              outgrew scanning once the catalog covered every collection. */}
          <TabsContent value="coarse">
            {/* What this subject holds, in one line - the question the dialog is opened to answer, previously
                answerable only by reading sixty dropdowns. */}
            <p className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="font-medium">{summary}</span>
              {viaRole && subjectKind === "user" && (
                <span className="text-muted-foreground">Role: {roleLabel(viaRole)}. Anything set here is an exception on top of it.</span>
              )}
            </p>
            <p className="mb-2 text-xs text-muted-foreground">Collection-wide access. Finer scope (own/department, fields, custom methods, single objects) is on the "All rules" tab and the in-context manage-access icons.</p>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Input className="h-8 min-w-[10rem] flex-1" placeholder="Filter collections…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <Button type="button" variant={onlyGranted ? "default" : "outline"} size="sm" className="h-8" onClick={() => setOnlyGranted((s) => !s)} aria-pressed={onlyGranted}>
                Only what's set
              </Button>
            </div>
            <div className="max-h-[55dvh] space-y-1 overflow-y-auto">
              {grouped.map(([group, cols]) => (
                <React.Fragment key={group}>
                  <p className="sticky top-0 z-10 bg-background px-2 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
                  {cols.map((c) => {
                    const v = saving[c] ?? valueOf(c);
                    const inherited = subjectKind === "user" ? roleValueOf(c) : "none";
                    return (
                      <div key={c} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-accent/40">
                        <span className="min-w-0 text-sm font-medium">
                          {labelOf(c)}
                          {/* The inherited level, so a "none" row is never mistaken for no access. */}
                          {inherited !== "none" && (
                            <span className="ml-2 text-xs font-normal text-muted-foreground">
                              role gives <span className={accessTone(inherited).text}>{inherited}</span>
                              {v !== "none" && v !== inherited ? " · overridden here" : ""}
                            </span>
                          )}
                        </span>
                        {isGlobal || !canWrite ? (
                          <Badge variant={v === "deny" ? "destructive" : v === "none" ? "muted" : "secondary"} className={v === "deny" || v === "none" ? undefined : accessTone(v).text}>{v}</Badge>
                        ) : (
                          <Select value={v} onValueChange={(nv) => setCell(c, nv)} disabled={c in saving}>
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
              {grouped.length === 0 && (
                <p className="px-2 py-3 text-sm text-muted-foreground">
                  {onlyGranted && !filter.trim() ? "Nothing is set here yet." : `No collection matches "${filter}".`}
                </p>
              )}
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
