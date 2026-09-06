import * as React from "react";
import { createPortal } from "react-dom";
import { Download, Upload, GitCompareArrows, KeyRound } from "lucide-react";
import { list, create, remove, get, patch, invoke } from "@/api";
import { ruleSentence, expiryLabel } from "@/components/access/ruleLogic";
import { Checkbox } from "@/components/ui/checkbox";
import { usePermission } from "@/lib/perm";
import { roleLabel, EVERYONE_ROLE } from "@/lib/roles";
import { CopyEmail } from "@/components/common/CopyEmail";
import { ruleScopeFor, ruleMatchesTarget } from "@/components/access/accessRuleScope";
import { type AccessRule, CELL, labelOf, fetchAllAccessRules, collectionsForRules, COLLECTION_GROUPS, groupOf, accessTone } from "@/components/access/permMatrix";
import { CellOption } from "@/components/access/CellOption";
import { cloneAccessRules, ruleBody } from "@/components/access/cloneRules";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { FineRulesEditor } from "@/components/access/FineRulesEditor";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import type { User } from "@/types";
import { getSetting } from "@/lib/settingsStore";

type Role = { path: string; name: string; label?: string };

// A roles x collections matrix of COLLECTION-WIDE (org-scope) access. Each cell edits the role's "all"-scope
// level rule for that collection through the same access-rules API the per-object ACL modal uses. Finer
// access (own/department, specific fields, custom methods, single objects) is managed via the manage-access
// icons throughout the app; this view is intentionally the broad, org-wide level per role.
export function PermissionsPanel({ controlsSlot }: { controlsSlot?: HTMLElement | null }) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const am = useAccessMode();
  const canManage = usePermission("access-rules.write");
  const canClone = usePermission("access-rules.clone"); // bulk copying is its own verb, granted separately
  const [compare, setCompare] = React.useState<{ a: string; b: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [rules, setRules] = React.useState<AccessRule[]>([]);
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [users, setUsers] = React.useState<{ path: string; email: string }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [subjectKind, setSubjectKind] = React.useState<"role" | "user">("role");
  const [view, setView] = React.useState<"matrix" | "rules">("matrix");

  // Four-eyes on permission changes (settings key `access-approval`). Read here so the switch and the queue
  // below live in the same place the changes are made.
  const [fourEyes, setFourEyes] = React.useState<boolean | null>(null);
  const canWriteSettings = usePermission("settings.write");
  React.useEffect(() => {
    getSetting<{ enabled?: boolean }>("access-approval")
      .then((s) => setFourEyes(s.value?.enabled === true))
      .catch(() => setFourEyes(null)); // not readable / not configured -> hide the switch rather than guess
  }, []);

  async function setFourEyesEnabled(enabled: boolean) {
    if (enabled && !(await confirm({ title: "Require a second approver for permission changes?", description: "From now on every access-rule change waits for a DIFFERENT access admin to approve it. A new grant does nothing until approved; a removal keeps working until approved. If you are the only access admin, nobody can approve your changes - turn this back off to unblock.", confirmLabel: "Turn on" }))) return;
    try {
      await patch("settings/access-approval", { value: { enabled } });
      setFourEyes(enabled);
      toast({ title: enabled ? "Permission changes now need a second approver" : "Permission changes apply immediately again", variant: "success" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
    }
  }

  async function decide(r: AccessRule, decision: "approve" | "reject") {
    setBusy(true);
    try {
      await invoke("access-rules", decision, undefined, { rule: r.path });
      toast({ title: decision === "approve" ? "Change approved" : "Change rejected", variant: "success" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: `Couldn't ${decision}`, description: String((e as Error).message) });
      setBusy(false);
    }
  }

  // The subjects first, the rules after - two stages, not one `Promise.all`.
  //
  // The grid's SHAPE is roles (or users) down the top and collections down the side, and neither of those
  // needs a single access rule to be known: the rules only decide what each cell says. But `fetchAllAccessRules`
  // walks the whole collection a cursor at a time, and an org with the seeded grants is a dozen sequential
  // round trips - so waiting for it before drawing anything left this page as a column of collection names
  // with NO roles on it for as long as the walk took. That empty grid does not read as "still loading", it
  // reads as "no role has any access anywhere", which on the permissions page is the worst thing it could say.
  const reload = React.useCallback(async () => {
    setBusy(true);
    try {
      const [ro, us] = await Promise.all([list<Role>("roles"), list<User>("users")]);
      setRoles(ro.results);
      setUsers(us.results.map((u) => ({ path: u.path, email: u.email })));
      setRules(await fetchAllAccessRules());
    } catch (e) {
      toast({ variant: "destructive", title: "Could not load permissions", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }, [toast]);
  React.useEffect(() => {
    void reload();
  }, [reload]);

  type Kind = "role" | "user";
  // Collections to show as matrix columns/rows: the curated base + any collection a rule already targets.
  const collections = React.useMemo(() => collectionsForRules(rules), [rules]);
  const [matrixFilter, setMatrixFilter] = React.useState("");
  // 65 rows where most say "none" for every role buries the dozen that carry the org's access model. This
  // keeps the rows some role (or `everyone`) actually holds something on.
  const [onlySet, setOnlySet] = React.useState(false);
  // A subject with a global ("*"/"**") allow rule (super_admin) is admin everywhere - shown read-only.
  const isGlobal = (kind: Kind, subject: string) =>
    rules.some((r) => r.subject_kind === kind && r.subject === subject && (r.collection === "*" || r.collection === "**") && !r.field && !r.verb && r.effect === "allow");

  // The collection-wide level/deny rules for a subject on a collection (no field, no verb, scope all).
  const cellRules = (kind: Kind, subject: string, collection: string) =>
    rules.filter((r) => r.subject_kind === kind && r.subject === subject && !r.verb && ruleMatchesTarget(r, { collection }));

  const valueOf = (kind: Kind, subject: string, collection: string): string => {
    if (isGlobal(kind, subject)) return "admin";
    const rs = cellRules(kind, subject, collection);
    if (rs.some((r) => r.effect === "deny")) return "deny";
    return rs.find((r) => r.effect === "allow")?.level ?? "none";
  };

  // Matrix rows in module order ("People & org", "Leave", …, then anything outside the curated catalog),
  // filtered by label. Same grouping the per-subject dialog uses, so both read the same shape.
  const groupedCollections = React.useMemo(() => {
    const q = matrixFilter.trim().toLowerCase();
    let shown = q ? collections.filter((c) => labelOf(c).toLowerCase().includes(q) || c.includes(q)) : collections;
    if (onlySet) shown = shown.filter((c) => roles.some((r) => valueOf("role", r.name, c) !== "none"));
    const order = [...COLLECTION_GROUPS.map((g) => g.label), "Other"];
    const byGroup = new Map<string, string[]>();
    for (const c of shown) {
      const g = groupOf(c);
      const bucket = byGroup.get(g);
      if (bucket) bucket.push(c);
      else byGroup.set(g, [c]);
    }
    return order.filter((g) => byGroup.has(g)).map((g) => [g, byGroup.get(g)!] as const);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collections, matrixFilter, onlySet, roles, rules]);


  async function setCell(kind: Kind, subject: string, collection: string, value: string, label: string) {
    setBusy(true);
    try {
      for (const r of cellRules(kind, subject, collection)) await remove(r.path, r.etag); // edit = delete + create
      if (value !== "none") {
        const body = value === "deny" ? { effect: "deny" } : { level: value };
        await create("access-rules", { subject_kind: kind, subject, collection, ...ruleScopeFor({ collection }), ...body });
      }
      toast({ title: `Updated ${label} · ${labelOf(collection)}` });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not update", description: String((e as Error).message) });
      setBusy(false);
    }
  }

  // What the subject ALSO holds on this collection beyond the org-wide cell: the `everyone` rule the engine
  // unions into every role, and any narrower (own/department/one-object/field/method) rules. Without these
  // the matrix reads as the whole truth while the real answer lives in rules it doesn't show.
  const everyoneLevel = (collection: string): string | null => {
    const rs = rules.filter((r) => r.subject_kind === "role" && r.subject === EVERYONE_ROLE && !r.verb && ruleMatchesTarget(r, { collection }));
    if (rs.some((r) => r.effect === "deny")) return "deny";
    return rs.find((r) => r.effect === "allow")?.level ?? null;
  };
  const narrowerCount = (kind: Kind, subject: string, collection: string): number =>
    rules.filter((r) => r.subject_kind === kind && r.subject === subject && r.collection === collection && (r.scope !== "all" || !!r.field || !!r.verb)).length;

  // A reusable level cell (used by the roles matrix and the users matrix): the editable org-wide level, plus
  // the effective-access context around it, plus a key that opens the full ACL modal for that collection -
  // so the org-wide view is a way IN to the per-collection editor, not a dead end.
  const levelCell = (kind: Kind, subject: string, collection: string, label: string) => {
    const v = valueOf(kind, subject, collection);
    const inherited = kind === "role" && subject !== EVERYONE_ROLE ? everyoneLevel(collection) : null;
    const narrower = narrowerCount(kind, subject, collection);
    const control =
      isGlobal(kind, subject) || !canManage ? (
        <Badge variant={v === "deny" ? "destructive" : v === "none" ? "muted" : "secondary"} className={v === "deny" || v === "none" ? undefined : accessTone(v).text}>{v}</Badge>
      ) : (
        // line-clamp-none + flex: the default value slot is a -webkit-box, which breaks the dot+label row.
        <Select value={v} onValueChange={(nv) => setCell(kind, subject, collection, nv, label)} disabled={busy}>
          <SelectTrigger className="h-8 w-28 shrink-0 [&>span]:flex [&>span]:items-center [&>span]:line-clamp-none"><SelectValue /></SelectTrigger>
          <SelectContent>{CELL.map((l) => <SelectItem key={l} value={l}><CellOption value={l} /></SelectItem>)}</SelectContent>
        </Select>
      );
    return (
      <div className="flex items-center gap-1">
        {control}
        <button
          type="button"
          title={`Manage access for ${labelOf(collection)} (scopes, fields, custom methods, single objects)`}
          onClick={() => am.open({ collection, label: labelOf(collection) })}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-amber-600 opacity-40 transition hover:bg-amber-100 hover:opacity-100 dark:hover:bg-amber-950"
        >
          <KeyRound className="h-3.5 w-3.5" />
        </button>
        {(inherited || narrower > 0) && (
          <span className="whitespace-nowrap text-[10px] text-muted-foreground" title={[inherited ? `Everyone already grants ${inherited} here, so this subject effectively has it.` : "", narrower ? `${narrower} narrower rule(s): own/department scope, a field, a custom method or one object.` : ""].filter(Boolean).join(" ")}>
            {inherited ? `+all:${inherited}` : ""}
            {inherited && narrower ? " " : ""}
            {narrower ? `+${narrower}` : ""}
          </span>
        )}
      </div>
    );
  };

  // Users matrix: one row per user (DataTable paginates them), one column per collection.
  const userMatrixCols: Column<{ path: string; email: string }>[] = [
    { id: "user", header: "User", filter: "text", accessor: (u) => u.email, cell: (u) => <CopyEmail email={u.email} className="font-medium" /> },
    ...collections.map((c) => ({ id: c, header: labelOf(c), sortable: false, filter: "none", accessor: (u: { path: string; email: string }) => valueOf("user", u.path, c), cell: (u: { path: string; email: string }) => levelCell("user", u.path, c, u.email) } as Column<{ path: string; email: string }>)),
  ];

  // Rules as JSON: the reviewable, diffable, restorable form of the whole access configuration. Export is a
  // plain download of every rule in its create-body shape; import replays those bodies through the SAME API
  // (and therefore the same validation, four-eyes queue and audit trail) - never a direct row write.
  function exportRules() {
    const payload = { exported_at: new Date().toISOString(), rules: rules.filter((r) => r.subject_kind === subjectKind).map(ruleBody) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `access-rules-${subjectKind}s-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importRules(file: File) {
    let bodies: Record<string, unknown>[];
    try {
      const parsed = JSON.parse(await file.text()) as { rules?: Record<string, unknown>[] } | Record<string, unknown>[];
      bodies = Array.isArray(parsed) ? parsed : parsed.rules ?? [];
      if (!bodies.length) throw new Error("no rules in that file");
    } catch (e) {
      toast({ variant: "destructive", title: "Could not read that file", description: String((e as Error).message) });
      return;
    }
    if (!(await confirm({ title: `Add ${bodies.length} access rules?`, description: "Rules that already exist are skipped. Nothing is removed - an import only ADDS access, so review the file first.", confirmLabel: "Import" }))) return;
    setBusy(true);
    let added = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const b of bodies) {
      try {
        await create("access-rules", b);
        added++;
      } catch (e) {
        const msg = String((e as Error).message);
        if (msg.toLowerCase().includes("already exists")) skipped++;
        else failed.push(msg);
      }
    }
    toast({ title: `Imported ${added} rules`, description: `${skipped} already existed${failed.length ? ` · ${failed.length} rejected: ${failed[0]}` : ""}`, variant: failed.length ? "destructive" : "success" });
    await reload();
  }

  // Copy every rule one subject holds onto another - the honest way to make "same as HR, plus payroll"
  // instead of hand-rebuilding 40 rules and missing three.
  async function cloneRules(from: { kind: Kind; subject: string }, to: { kind: Kind; subject: string }) {
    // Only ACTIVE rules are copied (the server's rule): a rule still waiting on a second approver is a
    // request, not a grant, so the count in the prompt has to leave those out or it promises more than lands.
    const source = rules.filter((r) => r.subject_kind === from.kind && r.subject === from.subject && (r.status ?? "active") === "active");
    if (!(await confirm({ title: `Copy ${source.length} rules?`, description: `Every rule ${from.kind === "role" ? roleLabel(from.subject) : from.subject} holds is added to ${to.kind === "role" ? roleLabel(to.subject) : to.subject}. Existing rules there are kept; nothing is removed. The whole copy is recorded as one change in the activity trail.`, confirmLabel: "Copy" }))) return;
    setBusy(true);
    const { added, skipped, failed, first_error } = await cloneAccessRules(from, to);
    toast({
      title: `Copied ${added} rules${skipped ? ` · ${skipped} already there` : ""}${failed ? ` · ${failed} rejected` : ""}`,
      ...(failed ? { description: first_error } : {}),
      variant: failed ? "destructive" : "success",
    });
    await reload();
  }

  const toggles = (
    <>
      <div className="flex gap-0.5 rounded-md border p-0.5">
        <Button size="sm" variant={view === "matrix" ? "default" : "ghost"} className="h-7" onClick={() => setView("matrix")}>By collection</Button>
        <Button size="sm" variant={view === "rules" ? "default" : "ghost"} className="h-7" onClick={() => setView("rules")}>All rules</Button>
      </div>
      <div className="flex gap-0.5 rounded-md border p-0.5">
        <Button size="sm" variant={subjectKind === "role" ? "default" : "ghost"} className="h-7" onClick={() => setSubjectKind("role")}>Roles</Button>
        <Button size="sm" variant={subjectKind === "user" ? "default" : "ghost"} className="h-7" onClick={() => setSubjectKind("user")}>Users</Button>
      </div>
      {subjectKind === "role" && roles.length > 1 && (
        <Button size="sm" variant="outline" className="h-7" onClick={() => setCompare({ a: roles[0]!.name, b: roles[1]!.name })} title="Compare two roles side by side, and copy one's rules onto another">
          <GitCompareArrows className="h-3.5 w-3.5" /> Compare
        </Button>
      )}
      <Button size="sm" variant="outline" className="h-7" onClick={exportRules} title="Download every rule as JSON for review, backup or moving between environments">
        <Download className="h-3.5 w-3.5" /> Export
      </Button>
      {canManage && (
        <>
          <Button size="sm" variant="outline" className="h-7" onClick={() => fileRef.current?.click()} title="Add rules from a previously exported JSON file (additive; duplicates are skipped)">
            <Upload className="h-3.5 w-3.5" /> Import
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = ""; // let the same file be picked again after a failed import
              if (f) void importRules(f);
            }}
          />
        </>
      )}
    </>
  );

  const matrixNote = (
    <p className="mb-3 text-sm text-muted-foreground">
      Collection-wide access. Finer access - own/department scope, specific fields, custom methods, single
      objects - is on "All rules" and the in-context manage-access icons. A <strong>deny</strong> always wins.
    </p>
  );

  // Two roles side by side, collection by collection, differences only by default - the question "what does
  // manager actually have that hr_admin doesn't?" had no answer short of reading both columns of a 65-row
  // matrix. Doubles as the copy tool: clone either direction once you can see the gap.
  const compareDialog = compare && (
    <Dialog open onOpenChange={(o) => !o && setCompare(null)}>
      <DialogContent className="max-w-3xl lg:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitCompareArrows className="h-5 w-5 text-primary" /> Compare roles
          </DialogTitle>
          <DialogDescription>Org-wide level per collection. Rows where the two roles differ are listed first.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          {(["a", "b"] as const).map((side) => (
            <div key={side}>
              <label className="mb-1 block text-xs font-medium">{side === "a" ? "Role A" : "Role B"}</label>
              <Select value={compare[side]} onValueChange={(v) => setCompare({ ...compare, [side]: v })}>
                <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>{roles.map((r) => <SelectItem key={r.name} value={r.name}>{r.label || roleLabel(r.name)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ))}
          {canClone && (
            // Copying a whole role's rules is its own grantable custom method (`access-rules:clone`), so it
            // carries its own verb target - an org can hand bulk copying to a specific role, or keep it back
            // from admins who may still author rules one at a time.
            <AccessAction verb="clone" collection="access-rules" label="Copy permissions between subjects">
              <span className="flex gap-2">
                <Button size="sm" variant="outline" disabled={busy} onClick={() => cloneRules({ kind: "role", subject: compare.a }, { kind: "role", subject: compare.b })}>
                  Copy A → B
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => cloneRules({ kind: "role", subject: compare.b }, { kind: "role", subject: compare.a })}>
                  Copy B → A
                </Button>
              </span>
            </AccessAction>
          )}
        </div>
        {(() => {
          const rows = collections
            .map((c) => ({ c, a: valueOf("role", compare.a, c), b: valueOf("role", compare.b, c) }))
            .sort((x, y) => Number(x.a === x.b) - Number(y.a === y.b) || groupOf(x.c).localeCompare(groupOf(y.c)) || x.c.localeCompare(y.c));
          const diffs = rows.filter((r) => r.a !== r.b).length;
          return (
            <>
              <p className="text-xs text-muted-foreground">{diffs} of {rows.length} collections differ.</p>
              <div className="scroll-shadow-x overflow-x-auto rounded-lg border">
                {/* Two roles side by side is a comparison, not a matrix: on a phone each collection becomes
                    a block naming both roles, which still answers "where do these two differ". */}
                <table className="table-stack w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b bg-muted/40">
                      <th className="px-3 py-2 text-left font-semibold">Collection</th>
                      <th className="px-3 py-2 text-left font-semibold">{roleLabel(compare.a)}</th>
                      <th className="px-3 py-2 text-left font-semibold">{roleLabel(compare.b)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.c} className={r.a !== r.b ? "border-b bg-amber-50/50 last:border-0 dark:bg-amber-950/20" : "border-b last:border-0"}>
                        <td className="px-3 py-1.5 font-medium">{labelOf(r.c)}</td>
                        <td data-label={roleLabel(compare.a)} className="px-3 py-1.5">{r.a}</td>
                        <td data-label={roleLabel(compare.b)} className="px-3 py-1.5">{r.b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        })()}
      </DialogContent>
    </Dialog>
  );

  // Everything waiting on a second approver, across every collection - the queue the four-eyes setting
  // creates. Without one place listing them, a pending change is only visible to whoever opens that exact
  // key icon, which is how a "requested" grant sits unnoticed for a week.
  const pending = rules.filter((r) => r.status === "pending" || r.status === "pending_delete");
  const pendingCard = (pending.length > 0 || fourEyes !== null) && (
    <Card className="mb-3">
      <CardContent className="space-y-2 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">Permission changes</p>
            <p className="text-xs text-muted-foreground">
              {fourEyes ? "Every change waits for a different access admin to approve it." : "Changes apply immediately. Turn on four-eyes approval to require a second admin."}
            </p>
          </div>
          {fourEyes !== null && canWriteSettings && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={fourEyes} onCheckedChange={(v) => void setFourEyesEnabled(v === true)} /> Require a second approver
            </label>
          )}
        </div>
        {pending.map((r) => (
          <div key={r.path} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50/60 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950/30">
            <span className="min-w-0">
              <Badge variant="secondary" className="mr-2 text-amber-700 dark:text-amber-400">{r.status === "pending" ? "new grant" : "removal"}</Badge>
              {ruleSentence(r, r.subject_kind === "role" ? roleLabel(r.subject) : users.find((u) => u.path === r.subject)?.email ?? "a person")}
              {expiryLabel(r.expire_time) ? ` · ${expiryLabel(r.expire_time)}` : ""}
            </span>
            {canManage && (
              // Deciding a pending change is itself a grantable custom method, so each button carries its own
              // verb target: an org can hand "approve permission changes" to a specific role without handing
              // over the write that queues them.
              <span className="flex gap-1">
                <AccessAction verb="approve" collection="access-rules" label="Approve permission changes">
                  <Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => decide(r, "approve")}>Approve</Button>
                </AccessAction>
                <AccessAction verb="reject" collection="access-rules" label="Reject permission changes">
                  <Button size="sm" variant="ghost" className="h-7 text-destructive" disabled={busy} onClick={() => decide(r, "reject")}>Reject</Button>
                </AccessAction>
              </span>
            )}
          </div>
        ))}
        {pending.length === 0 && fourEyes && <p className="text-xs text-muted-foreground">Nothing is waiting for approval.</p>}
      </CardContent>
    </Card>
  );

  return (
    <>
      {controlsSlot ? createPortal(toggles, controlsSlot) : null}
      {compareDialog}
      {pendingCard}
      <Card>
      <CardContent className="pt-4 sm:pt-6">
        {view === "rules" ? (
          subjectKind === "user" ? (
            <FineRulesEditor rules={rules.filter((r) => r.subject_kind === "user")} reload={reload} userOptions={users} canWrite={canManage} controlsSlot={controlsSlot} />
          ) : (
            <FineRulesEditor rules={rules.filter((r) => r.subject_kind === "role")} reload={reload} roleOptions={roles.map((r) => ({ name: r.name, label: r.label || roleLabel(r.name) }))} canWrite={canManage} controlsSlot={controlsSlot} />
          )
        ) : subjectKind === "user" ? (
          // Users x collections: a row per user (paginated by DataTable), a column per collection.
          <div className="space-y-3">
            {matrixNote}
            <DataTable columns={userMatrixCols} rows={users} getRowId={(u) => u.path} tableId="user-perms-matrix" emptyTitle="No users" controlsSlot={controlsSlot} />
          </div>
        ) : (
          // Roles x collections: a row per collection, a column per role, grouped by module and filterable -
          // 65 flat rows is a wall, and the grouping already exists in the collection registry.
          <div className="space-y-3">
            {matrixNote}
            <div className="flex flex-wrap items-center gap-2">
              <Input className="h-8 max-w-xs" placeholder="Filter collections…" value={matrixFilter} onChange={(e) => setMatrixFilter(e.target.value)} />
              <Button size="sm" variant={onlySet ? "default" : "outline"} className="h-8" aria-pressed={onlySet} onClick={() => setOnlySet((s) => !s)}>
                Only rows with access
              </Button>
              <span className="text-xs text-muted-foreground">{groupedCollections.reduce((n, [, c]) => n + c.length, 0)} of {collections.length} collections</span>
            </div>
            <div className="scroll-shadow-x overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-semibold">Collection</th>
                    {/* The role's OWN label first: `roleLabel` only knows the built-in roles and falls back
                        to the raw identifier, so a role the org created and named read as `finance_lead`
                        here while every picker called it "Finance Lead". */}
                    {roles.map((r) => (
                      <th key={r.name} className="whitespace-nowrap px-3 py-2 text-left font-semibold">{r.label || roleLabel(r.name)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {groupedCollections.map(([group, cols]) => (
                    <React.Fragment key={group}>
                      <tr className="border-b bg-muted/20">
                        <td className="sticky left-0 z-10 bg-muted/20 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground" colSpan={1}>{group}</td>
                        <td colSpan={roles.length} />
                      </tr>
                      {cols.map((c) => (
                        <tr key={c} className="border-b last:border-0">
                          <td className="sticky left-0 z-10 bg-background px-3 py-1.5 font-medium">{labelOf(c)}</td>
                          {roles.map((role) => (
                            <td key={role.name} className="px-3 py-1.5">{levelCell("role", role.name, c, roleLabel(role.name))}</td>
                          ))}
                        </tr>
                      ))}
                    </React.Fragment>
                  ))}
                  {groupedCollections.length === 0 && (
                    <tr>
                      <td className="px-3 py-3 text-sm text-muted-foreground" colSpan={roles.length + 1}>{onlySet && !matrixFilter.trim() ? "No role has access to any collection yet." : `No collection matches "${matrixFilter}".`}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
      </Card>
    </>
  );
}
