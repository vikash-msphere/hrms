import * as React from "react";
import { createPortal } from "react-dom";
import { list, create, remove } from "@/api";
import { usePermission } from "@/lib/perm";
import { roleLabel } from "@/lib/roles";
import { ruleScopeFor, ruleMatchesTarget } from "@/components/access/accessRuleScope";
import { type AccessRule, CELL, labelOf, fetchAllAccessRules, collectionsForRules } from "@/components/access/permMatrix";
import { FineRulesEditor } from "@/components/access/FineRulesEditor";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import type { User } from "@/types";

type Role = { path: string; name: string; label?: string };

// A roles x collections matrix of COLLECTION-WIDE (org-scope) access. Each cell edits the role's "all"-scope
// level rule for that collection through the same access-rules API the per-object ACL modal uses. Finer
// access (own/department, specific fields, custom methods, single objects) is managed via the manage-access
// icons throughout the app; this view is intentionally the broad, org-wide level per role.
export function PermissionsPanel({ controlsSlot }: { controlsSlot?: HTMLElement | null }) {
  const { toast } = useToast();
  const canManage = usePermission("access-rules.write");
  const [rules, setRules] = React.useState<AccessRule[]>([]);
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [users, setUsers] = React.useState<{ path: string; email: string }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [subjectKind, setSubjectKind] = React.useState<"role" | "user">("role");
  const [view, setView] = React.useState<"matrix" | "rules">("matrix");

  const reload = React.useCallback(async () => {
    setBusy(true);
    try {
      const [allRules, ro, us] = await Promise.all([fetchAllAccessRules(), list<Role>("roles"), list<User>("users")]);
      setRules(allRules);
      setRoles(ro.results);
      setUsers(us.results.map((u) => ({ path: u.path, email: u.email })));
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

  // A reusable level cell (used by the roles matrix and the users matrix).
  const levelCell = (kind: Kind, subject: string, collection: string, label: string) => {
    const v = valueOf(kind, subject, collection);
    if (isGlobal(kind, subject) || !canManage) {
      return <Badge variant={v === "deny" ? "destructive" : v === "none" ? "muted" : "secondary"}>{v}</Badge>;
    }
    return (
      <Select value={v} onValueChange={(nv) => setCell(kind, subject, collection, nv, label)} disabled={busy}>
        <SelectTrigger className="h-8 w-24"><SelectValue /></SelectTrigger>
        <SelectContent>{CELL.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
      </Select>
    );
  };

  // Users matrix: one row per user (DataTable paginates them), one column per collection.
  const userMatrixCols: Column<{ path: string; email: string }>[] = [
    { id: "user", header: "User", filter: "text", accessor: (u) => u.email, cell: (u) => <span className="font-medium">{u.email}</span> },
    ...collections.map((c) => ({ id: c, header: labelOf(c), sortable: false, filter: "none", accessor: (u: { path: string; email: string }) => valueOf("user", u.path, c), cell: (u: { path: string; email: string }) => levelCell("user", u.path, c, u.email) } as Column<{ path: string; email: string }>)),
  ];

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
    </>
  );

  const matrixNote = (
    <p className="mb-3 text-sm text-muted-foreground">
      Collection-wide access. Finer access - own/department scope, specific fields, custom methods, single
      objects - is on "All rules" and the in-context manage-access icons. A <strong>deny</strong> always wins.
    </p>
  );

  return (
    <>
      {controlsSlot ? createPortal(toggles, controlsSlot) : null}
      <Card>
      <CardContent className="pt-6">
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
          // Roles x collections: a row per collection, a column per role.
          <div className="space-y-3">
            {matrixNote}
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="sticky left-0 z-10 bg-muted/40 px-3 py-2 text-left font-semibold">Collection</th>
                    {roles.map((r) => (
                      <th key={r.name} className="whitespace-nowrap px-3 py-2 text-left font-semibold">{roleLabel(r.name)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {collections.map((c) => (
                    <tr key={c} className="border-b last:border-0">
                      <td className="sticky left-0 z-10 bg-background px-3 py-1.5 font-medium">{labelOf(c)}</td>
                      {roles.map((role) => (
                        <td key={role.name} className="px-3 py-1.5">{levelCell("role", role.name, c, roleLabel(role.name))}</td>
                      ))}
                    </tr>
                  ))}
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
