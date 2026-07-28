import { useEffect, useMemo, useState } from "react";
import { Network, Building2, ChevronDown, ChevronRight, Crosshair, Search, Users, X, GripVertical, CornerDownRight, ArrowUpToLine } from "lucide-react";
import { patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { idOf, cn } from "@/lib/utils";
import { leaveColor } from "@/lib/leaveColors";
import { navigate } from "@/router";
import type { Me, Employee, Department } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessItem } from "@/components/access/AccessItem";
import { AccessTarget } from "@/components/access/AccessTarget";
import { TruncationNotice } from "@/components/common/TruncationNotice";

type TreeNode = { id: string; parentId: string | null; label: string; sub: string; search: string; childIds: string[] };
type View = "people" | "departments";

export default function OrgChart({ me }: { me: Me }) {
  void me;
  const { rows: employees, state: empState, error: empErr, reload: reloadEmp } = useCollection<Employee>("employees");
  const { rows: departments, state: deptState, reload: reloadDept } = useCollection<Department>("departments");
  const confirm = useConfirm();
  const { toast } = useToast();

  const [view, setView] = useState<View>("people");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null); // hovered drop target (incl. "__root__")
  const [moveFrom, setMoveFrom] = useState<string | null>(null); // node being moved via the picker

  const canEditPeople = usePermission("employees.write");
  const canEditDepts = usePermission("departments.write");
  const canEdit = view === "people" ? canEditPeople : canEditDepts;

  const empById = useMemo(() => new Map(employees.filter((e) => !e.delete_time).map((e) => [idOf(e.path), e] as const)), [employees]);
  const deptById = useMemo(() => new Map(departments.filter((d) => !d.delete_time).map((d) => [idOf(d.path), d] as const)), [departments]);
  const deptName = (ref?: string) => (ref ? deptById.get(idOf(ref))?.display_name : undefined);
  const empName = (ref?: string) => { const e = ref ? empById.get(idOf(ref)) : undefined; return e ? `${e.first_name} ${e.last_name}` : undefined; };
  const deptColor = (ref?: string) => (ref ? leaveColor(undefined, idOf(ref)) : undefined);

  // Direct head-count per department (members whose `department` is that dept).
  const deptHeadcount = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of empById.values()) if (e.department) m.set(idOf(e.department), (m.get(idOf(e.department)) ?? 0) + 1);
    return m;
  }, [empById]);

  // Build the node map + childIds for the active view. A parent ref outside the visible set makes the node a
  // root, so nothing is orphaned. `sub` is the card's secondary line; `search` is the match text.
  const { nodes, roots } = useMemo(() => {
    const nodes = new Map<string, TreeNode>();
    if (view === "people") {
      for (const [id, e] of empById) {
        const mgr = e.manager ? idOf(e.manager) : null;
        nodes.set(id, {
          id,
          parentId: mgr && empById.has(mgr) ? mgr : null,
          label: `${e.first_name} ${e.last_name}`,
          sub: e.job_title ?? "",
          search: `${e.first_name} ${e.last_name} ${e.job_title ?? ""} ${deptName(e.department) ?? ""}`.toLowerCase(),
          childIds: [],
        });
      }
    } else {
      for (const [id, d] of deptById) {
        const parent = d.parent ? idOf(d.parent) : null;
        const mgrs = (d.managers ?? []).map((m) => empName(m)).filter(Boolean) as string[];
        nodes.set(id, {
          id,
          parentId: parent && deptById.has(parent) ? parent : null,
          label: d.display_name,
          sub: mgrs.join(", "),
          search: `${d.display_name} ${mgrs.join(" ")}`.toLowerCase(),
          childIds: [],
        });
      }
    }
    for (const n of nodes.values()) if (n.parentId && nodes.has(n.parentId)) nodes.get(n.parentId)!.childIds.push(n.id);
    for (const n of nodes.values()) n.childIds.sort((a, b) => nodes.get(a)!.search.localeCompare(nodes.get(b)!.search));
    const roots = [...nodes.values()].filter((n) => !n.parentId).map((n) => n.id).sort((a, b) => nodes.get(a)!.search.localeCompare(nodes.get(b)!.search));
    return { nodes, roots };
  }, [view, empById, deptById]);

  // Total descendants per node (rich rollup), computed once per tree.
  const totalDesc = useMemo(() => {
    const memo = new Map<string, number>();
    const walk = (id: string, seen: Set<string>): number => {
      if (memo.has(id)) return memo.get(id)!;
      if (seen.has(id)) return 0;
      const next = new Set(seen).add(id);
      let t = 0;
      for (const c of nodes.get(id)?.childIds ?? []) t += 1 + walk(c, next);
      memo.set(id, t);
      return t;
    };
    for (const id of nodes.keys()) walk(id, new Set());
    return memo;
  }, [nodes]);

  // For departments: members in a dept's whole subtree (direct + descendant depts).
  const subtreeMembers = useMemo(() => {
    if (view !== "departments") return new Map<string, number>();
    const memo = new Map<string, number>();
    const walk = (id: string, seen: Set<string>): number => {
      if (memo.has(id)) return memo.get(id)!;
      if (seen.has(id)) return 0;
      const next = new Set(seen).add(id);
      let t = deptHeadcount.get(id) ?? 0;
      for (const c of nodes.get(id)?.childIds ?? []) t += walk(c, next);
      memo.set(id, t);
      return t;
    };
    for (const id of nodes.keys()) walk(id, new Set());
    return memo;
  }, [view, nodes, deptHeadcount]);

  // Descendant set of a node (for cycle-safe move validation).
  const descendantsOf = (id: string): Set<string> => {
    const out = new Set<string>();
    const walk = (x: string) => { for (const c of nodes.get(x)?.childIds ?? []) if (!out.has(c)) { out.add(c); walk(c); } };
    walk(id);
    return out;
  };

  // Aggregate stats for the header bar.
  const stats = useMemo(() => {
    const managers = [...nodes.values()].filter((n) => n.childIds.length > 0);
    const span = managers.length ? managers.reduce((s, n) => s + n.childIds.length, 0) / managers.length : 0;
    let maxDepth = 0;
    const depth = (id: string, d: number, seen: Set<string>) => {
      if (seen.has(id)) return;
      maxDepth = Math.max(maxDepth, d);
      const next = new Set(seen).add(id);
      for (const c of nodes.get(id)?.childIds ?? []) depth(c, d + 1, next);
    };
    for (const r of roots) depth(r, 1, new Set());
    return { total: nodes.size, managers: managers.length, topLevel: roots.length, maxDepth, span };
  }, [nodes, roots]);

  // Search: matched ids + the ancestor chains to force-open so matches are revealed.
  const q = query.trim().toLowerCase();
  const { matches, forceOpen } = useMemo(() => {
    const matches = new Set<string>();
    const forceOpen = new Set<string>();
    if (q) {
      for (const n of nodes.values()) if (n.search.includes(q)) matches.add(n.id);
      for (const id of matches) { let p = nodes.get(id)?.parentId ?? null; while (p) { forceOpen.add(p); p = nodes.get(p)?.parentId ?? null; } }
    }
    return { matches, forceOpen };
  }, [q, nodes]);

  // Bring the first match into view - on a wide chart a highlight ring alone is easy to miss.
  useEffect(() => {
    if (!q || matches.size === 0) return;
    const t = window.setTimeout(() => {
      const first = [...matches][0];
      document.querySelector(`[data-org-id="${CSS.escape(first)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }, 80); // after force-opened ancestors render
    return () => window.clearTimeout(t);
  }, [q, matches]);

  const isOpen = (id: string) => forceOpen.has(id) || !collapsed.has(id);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const collapseAll = () => setCollapsed(new Set([...nodes.values()].filter((n) => n.childIds.length).map((n) => n.id)));
  const expandAll = () => setCollapsed(new Set());

  const focusTrail = useMemo(() => {
    if (!focusId) return [];
    const trail: string[] = []; let id: string | null = focusId;
    while (id) { trail.unshift(id); id = nodes.get(id)?.parentId ?? null; }
    return trail;
  }, [focusId, nodes]);

  // Apply a reparent: people -> set manager; departments -> set parent. null = make top-level. Cycle-guarded.
  async function applyMove(id: string, targetId: string | null, opts: { confirm?: boolean } = {}) {
    const node = nodes.get(id);
    if (!node) return;
    if (targetId === id) return;
    if ((targetId ?? null) === node.parentId) return; // no-op
    if (targetId && descendantsOf(id).has(targetId)) {
      toast({ variant: "destructive", title: "Can't move there", description: `${node.label} can't report into its own ${view === "people" ? "report" : "sub-department"}.` });
      return;
    }
    const targetLabel = targetId ? nodes.get(targetId)?.label : null;
    if (opts.confirm !== false) {
      const ok = await confirm({
        title: targetId ? `Move ${node.label}?` : `Make ${node.label} top-level?`,
        description: view === "people"
          ? (targetId ? `${node.label} will report to ${targetLabel}.` : `${node.label} will have no manager.`)
          : (targetId ? `${node.label} will sit under ${targetLabel}.` : `${node.label} will become a top-level department.`),
        confirmLabel: "Move",
      });
      if (!ok) return;
    }
    try {
      if (view === "people") {
        const e = empById.get(id)!;
        await patch(e.path, { manager: targetId ? empById.get(targetId)!.path : null }, e.etag);
        reloadEmp();
      } else {
        const d = deptById.get(id)!;
        await patch(d.path, { parent: targetId ? deptById.get(targetId)!.path : null }, d.etag);
        reloadDept();
      }
      toast({ title: "Reporting line updated", variant: "success" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't move", description: (e as Error).message });
    }
  }

  // A drop target is valid if it isn't the dragged node, its current parent, or one of its descendants.
  const validDrop = (targetId: string | null) => {
    if (!dragId) return false;
    if (targetId === dragId) return false;
    if ((targetId ?? null) === (nodes.get(dragId)?.parentId ?? null)) return false;
    if (targetId && descendantsOf(dragId).has(targetId)) return false;
    return true;
  };
  const onDrop = (targetId: string | null) => {
    const id = dragId;
    setDragId(null); setDropId(null);
    if (id && validDrop(targetId)) void applyMove(id, targetId);
  };

  const displayRoots = focusId && nodes.has(focusId) ? [focusId] : roots;

  function renderNode(id: string, seen: Set<string>) {
    const n = nodes.get(id);
    if (!n || seen.has(id)) return null;
    const next = new Set(seen).add(id);
    const hasKids = n.childIds.length > 0;
    const open = isOpen(id);
    const matched = matches.has(id);
    const e = view === "people" ? empById.get(id) : undefined;
    const accent = view === "people" ? deptColor(e?.department) : deptColor(`departments/${id}`);
    const total = totalDesc.get(id) ?? 0;
    const isDropOk = dropId === id && validDrop(id);
    const accessCol = view === "people" ? "employees" : "departments";
    const accessRow = view === "people" ? e : deptById.get(id);
    const accessCan = accessRow?.access?.can;
    return (
      <li key={id}>
        <AccessItem collection={accessCol} objectPath={`${accessCol}/${id}`} can={accessCan} why={accessRow?.access?.why} label={n.label} iconClassName="absolute left-1 top-1 z-20 bg-card">
        <div
          data-org-id={id}
          draggable={canEdit}
          onDragStart={(ev) => { if (!canEdit) return; ev.dataTransfer.effectAllowed = "move"; setDragId(id); }}
          onDragEnd={() => { setDragId(null); setDropId(null); }}
          onDragOver={(ev) => { if (validDrop(id)) { ev.preventDefault(); setDropId(id); } }}
          onDragLeave={() => setDropId((d) => (d === id ? null : d))}
          onDrop={(ev) => { ev.preventDefault(); onDrop(id); }}
          style={{ borderLeftColor: accent, borderLeftWidth: accent ? 3 : undefined }}
          className={cn(
            "group/card relative w-[176px] rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-colors",
            matched && "ring-2 ring-primary", q && !matched && "opacity-60",
            // While dragging, fade everything that isn't a legal drop target (the dragged card, its current
            // parent, its descendants) so where you CAN drop is visible before you hover it.
            dragId === id && "opacity-40", dragId && dragId !== id && !validDrop(id) && "opacity-40",
            isDropOk && "ring-2 ring-emerald-500",
          )}
        >
          <div className="absolute right-1 top-1 flex">
            {canEdit && <button type="button" onClick={() => setMoveFrom(id)} title="Move…" className="rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground"><CornerDownRight className="h-3.5 w-3.5" /></button>}
            <button type="button" onClick={() => setFocusId(id)} title="Focus on this subtree" className="rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground"><Crosshair className="h-3.5 w-3.5" /></button>
          </div>
          {canEdit && (
            <span title="Drag onto another card to move" className="absolute left-1 top-1/2 -translate-y-1/2 cursor-grab text-muted-foreground/30 transition-colors group-hover/card:text-muted-foreground/80">
              <GripVertical className="h-3.5 w-3.5" />
            </span>
          )}

          {view === "people" && e ? (
            <button type="button" onClick={() => navigate(`employees/${id}`)} className="flex w-full flex-col items-center gap-1 text-center">
              <PhotoAvatar employeeId={id} name={n.label} photo={e.photo} className="h-11 w-11" />
              <span className="text-sm font-semibold leading-tight hover:underline">{n.label}</span>
              {n.sub && <span className="text-xs text-muted-foreground">{n.sub}</span>}
              {e.department && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />{deptName(e.department)}</span>}
            </button>
          ) : (
            <div className="flex flex-col items-center gap-1 text-center">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ backgroundColor: `${accent}22`, color: accent }}><Building2 className="h-5 w-5" /></span>
              <span className="text-sm font-semibold leading-tight">{n.label}</span>
              {n.sub && <span className="text-xs text-muted-foreground">{n.sub}</span>}
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {deptHeadcount.get(id) ?? 0} direct{(subtreeMembers.get(id) ?? 0) !== (deptHeadcount.get(id) ?? 0) ? ` · ${subtreeMembers.get(id) ?? 0} total` : ""}
              </span>
            </div>
          )}

          {hasKids && (
            <button type="button" onClick={() => toggle(id)} className="mx-auto mt-1.5 flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent">
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              <Users className="h-3 w-3" /> {n.childIds.length}{total !== n.childIds.length ? ` · ${total}` : ""}
            </button>
          )}
        </div>
        </AccessItem>
        {hasKids && open && <ul>{n.childIds.map((c) => renderNode(c, next))}</ul>}
      </li>
    );
  }

  const loading = view === "departments" && deptState === "loading";
  const stat = (label: string, value: string | number) => (
    <div className="flex flex-col rounded-lg border bg-card px-3 py-1.5"><span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span><span className="text-base font-semibold tabular-nums">{value}</span></div>
  );

  return (
    <div>
      <PageHeader
        title="Org Chart"
        description={canEdit ? "Drag a card onto another to change who it reports to, or use the move button. Click a card to open a profile." : "The reporting hierarchy and department structure. Click a card to open a profile."}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PageSettings me={me} host="org-chart" />
            {/* The People/Departments toggle is this page's tab bar - the collection-level access key rides on
                it (scoped to the active view), not on the page heading. */}
            <div className="flex items-center gap-1 rounded-md border p-0.5">
              <Button size="sm" variant={view === "people" ? "default" : "ghost"} className="h-7" onClick={() => { setView("people"); setFocusId(null); }}><Network className="h-4 w-4" /> People</Button>
              <Button size="sm" variant={view === "departments" ? "default" : "ghost"} className="h-7" onClick={() => { setView("departments"); setFocusId(null); }}><Building2 className="h-4 w-4" /> Departments</Button>
              <AccessTarget target={{ collection: view === "people" ? "employees" : "departments", label: view === "people" ? "People" : "Departments" }} className="ml-0.5 h-6 w-6" />
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find someone…" className="h-9 w-48 pl-8" />
            </div>
          </div>
        }
      />

      <TruncationNotice collection="employees" what="people" className="mb-3" />

      {/* Rich stats bar */}
      <div className="mb-4 flex flex-wrap gap-2">
        {stat(view === "people" ? "People" : "Departments", stats.total)}
        {stat("Managers", stats.managers)}
        {stat("Top-level", stats.topLevel)}
        {stat("Depth", stats.maxDepth)}
        {stat("Avg span", stats.span ? stats.span.toFixed(1) : "0")}
      </div>

      <DataState state={empState} error={empErr} onRetry={reloadEmp}>
        <Card>
          <CardContent className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                {focusId ? (
                  <>
                    <span>Focused:</span>
                    {focusTrail.map((id, i) => (
                      <span key={id} className="flex items-center gap-1.5">
                        {i > 0 && <ChevronRight className="h-3 w-3 opacity-50" />}
                        <button type="button" onClick={() => setFocusId(id)} className="font-medium text-foreground hover:underline">{nodes.get(id)?.label ?? "-"}</button>
                      </span>
                    ))}
                    <Button size="sm" variant="ghost" className="ml-1 h-6" onClick={() => setFocusId(null)}><X className="h-3.5 w-3.5" /> Full chart</Button>
                  </>
                ) : (
                  <span>{q ? `${matches.size} match${matches.size === 1 ? "" : "es"}` : "Showing what you're allowed to see"}</span>
                )}
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" className="h-7" onClick={expandAll}>Expand all</Button>
                <Button size="sm" variant="outline" className="h-7" onClick={collapseAll}>Collapse all</Button>
              </div>
            </div>

            {/* Make-top-level dropzone, shown while dragging a node that currently has a parent */}
            {dragId && nodes.get(dragId)?.parentId && (
              <div
                onDragOver={(ev) => { if (validDrop(null)) { ev.preventDefault(); setDropId("__root__"); } }}
                onDragLeave={() => setDropId((d) => (d === "__root__" ? null : d))}
                onDrop={(ev) => { ev.preventDefault(); onDrop(null); }}
                className={cn("mb-3 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed py-2 text-sm text-muted-foreground", dropId === "__root__" ? "border-emerald-500 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400" : "border-border")}
              >
                <ArrowUpToLine className="h-4 w-4" /> Drop here to make top-level (no {view === "people" ? "manager" : "parent"})
              </div>
            )}

            {loading ? (
              <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
            ) : displayRoots.length === 0 ? (
              <EmptyState icon={Network} title="Nothing to chart" description={view === "people" ? "No employees are visible to you." : "No departments defined yet."} />
            ) : (
              <div className="overflow-x-auto pb-2">
                <ul className="org-tree mx-auto w-max">{displayRoots.map((id) => renderNode(id, new Set()))}</ul>
              </div>
            )}
          </CardContent>
        </Card>
      </DataState>

      {moveFrom && (
        <MovePicker
          title={view === "people" ? "Change manager" : "Change parent department"}
          subjectLabel={nodes.get(moveFrom)?.label ?? ""}
          topLevelLabel={view === "people" ? "Top level (no manager)" : "Top level (no parent)"}
          candidates={[...nodes.values()].filter((n) => n.id !== moveFrom && !descendantsOf(moveFrom).has(n.id)).map((n) => ({ id: n.id, label: n.label, sub: n.sub }))}
          onPick={(targetId) => { const from = moveFrom; setMoveFrom(null); if (from) void applyMove(from, targetId, { confirm: false }); }}
          onClose={() => setMoveFrom(null)}
        />
      )}
    </div>
  );
}

// A searchable picker for the new parent/manager. "Top level" clears it.
function MovePicker({ title, subjectLabel, topLevelLabel, candidates, onPick, onClose }: {
  title: string;
  subjectLabel: string;
  topLevelLabel: string;
  candidates: { id: string; label: string; sub: string }[];
  onPick: (targetId: string | null) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const ql = q.trim().toLowerCase();
  const filtered = ql ? candidates.filter((c) => `${c.label} ${c.sub}`.toLowerCase().includes(ql)) : candidates;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <p className="-mt-1 text-sm text-muted-foreground">Moving <span className="font-medium text-foreground">{subjectLabel}</span>.</p>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" autoFocus />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          <button type="button" onClick={() => onPick(null)} className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent">
            <ArrowUpToLine className="h-4 w-4 text-muted-foreground" /> {topLevelLabel}
          </button>
          {filtered.map((c) => (
            <button key={c.id} type="button" onClick={() => onPick(c.id)} className="flex w-full flex-col rounded-md border px-3 py-2 text-left text-sm hover:bg-accent">
              <span className="font-medium">{c.label}</span>
              {c.sub && <span className="text-xs text-muted-foreground">{c.sub}</span>}
            </button>
          ))}
          {filtered.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No matches.</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
