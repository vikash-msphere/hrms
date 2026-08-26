import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Network, Building2, ChevronDown, ChevronRight, ChevronUp, Crosshair, Search, Users, X, GripVertical, CornerDownRight, ArrowUpToLine, ZoomIn, ZoomOut, Maximize2, Minimize2, LocateFixed, ListTree, Briefcase, CalendarClock, ImageDown, Printer } from "lucide-react";
import { patch } from "@/api";
import { useCollection } from "@/hooks/useCollection";
import { usePermission } from "@/lib/perm";
import { useConfirm } from "@/components/common/confirm";
import { useToast } from "@/components/ui/use-toast";
import { idOf, cn, tenureLabel } from "@/lib/utils";
import { leaveColor } from "@/lib/leaveColors";
import { navigate } from "@/router";
import type { Me, Employee, Department, LeaveRequest, JobRequisition } from "@/types";
import { PageHeader } from "@/components/common/PageHeader";
import { PageSettings } from "@/components/common/SettingsButton";
import { PhotoAvatar } from "@/components/common/PhotoAvatar";
import { DataState } from "@/components/common/DataState";
import { EmptyState } from "@/components/common/EmptyState";
import { CardsSkeleton } from "@/components/common/Skeletons";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { CopyEmail } from "@/components/common/CopyEmail";
import { AccessItem } from "@/components/access/AccessItem";
import { AccessTarget } from "@/components/access/AccessTarget";
import { TruncationNotice } from "@/components/common/TruncationNotice";

type TreeNode = { id: string; parentId: string | null; label: string; sub: string; search: string; childIds: string[] };
type View = "people" | "departments";

const ZOOMS = [0.5, 0.65, 0.8, 1, 1.25];

// "New"/"Joining" freshness from start_date alone (same rule as the Directory): joined within the
// last 30 days, or a future start already on the books. Deleted rows never badge.
function joinBadge(e: Employee): "New" | "Joining" | null {
  if (!e.start_date || e.delete_time) return null;
  const days = (Date.now() - new Date(e.start_date + "T00:00:00").getTime()) / 86400000;
  if (days < 0) return "Joining";
  return days <= 30 ? "New" : null;
}

function JoinPill({ label }: { label: string }) {
  return <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">{label}</span>;
}

// `focusId` deep-links straight to one person's subtree (the directory's "view in org chart").
export default function OrgChart({ me, focusId: initialFocusId }: { me: Me; focusId?: string }) {
  const { rows: employees, state: empState, error: empErr, reload: reloadEmp } = useCollection<Employee>("employees");
  const { rows: departments, state: deptState, reload: reloadDept } = useCollection<Department>("departments");
  const confirm = useConfirm();
  const { toast } = useToast();

  const [view, setView] = useState<View>("people");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(initialFocusId ?? null);
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null); // hovered drop target (incl. "__root__")
  const [moveFrom, setMoveFrom] = useState<string | null>(null); // node being moved via the picker
  // Zoom + layout survive reloads (localStorage; per-device presentation, not worth a server pref).
  // The `?? NaN` is load-bearing: `Number(null)` is 0, and 0 is a VALID index here - the 50% zoom. So a
  // first-time reader, who has nothing stored, passed the range check with index 0 and met the org chart at
  // half size, every control on it half-sized with it. Found by measuring the page in a fresh browser
  // profile, where "nothing stored yet" is the normal case rather than the rare one.
  const [zi, setZi] = useState(() => { const raw = localStorage.getItem("orgchart.zoom"); const v = Number(raw ?? NaN); return Number.isInteger(v) && v >= 0 && v < ZOOMS.length ? v : 3; });
  useEffect(() => localStorage.setItem("orgchart.zoom", String(zi)), [zi]);
  // A phone opens in the outline layout. The tree is a two-dimensional canvas - a node is 12rem wide and a
  // sibling row of six is most of a metre - so on a 360px screen the first thing a reader gets is one card
  // and two scrollbars, while the outline says the same thing in indented rows that only ever scroll down.
  // A stored choice still wins: the toggle is per device (localStorage), so picking the tree on a phone
  // sticks, and this only decides the first visit. Read as a one-off rather than through `useMedia` on
  // purpose - the layout is a preference from here on, not something a rotation should overwrite.
  const [layout, setLayout] = useState<"tree" | "list">(() => {
    const stored = localStorage.getItem("orgchart.layout");
    if (stored === "list" || stored === "tree") return stored;
    return typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches ? "list" : "tree";
  });
  useEffect(() => localStorage.setItem("orgchart.layout", layout), [layout]);
  const [full, setFull] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null); // just-located node, briefly ringed
  const [matchIdx, setMatchIdx] = useState(0); // which search match is "current"
  const [peekId, setPeekId] = useState<string | null>(null); // card whose quick-profile popover is open
  const [deptFilter, setDeptFilter] = useState<Set<string>>(new Set()); // legend chips: dim everyone outside these depts

  // Overlays are opt-in toggles so their collections only load on explicit request (D1 read minimization),
  // and the toggles only render for callers who can read the backing collection at all.
  const [showLeave, setShowLeave] = useState(false);
  const [showVacancies, setShowVacancies] = useState(false);
  const canSeeLeaves = usePermission("leave-requests.read");
  const canSeeReqs = usePermission("job-requisitions.read");
  const { rows: leaves, state: leaveState } = useCollection<LeaveRequest>("leave-requests", { enabled: showLeave, max: 500 });
  const { rows: reqs, state: reqState } = useCollection<JobRequisition>("job-requisitions", { enabled: showVacancies });

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

  // Matches are cyclable: Enter in the search box (or the arrows next to the count) steps the "current"
  // match, and the chart scrolls to it - on a wide chart a highlight ring alone is easy to miss.
  const matchList = useMemo(() => [...matches], [matches]);
  useEffect(() => setMatchIdx(0), [matchList]);
  const stepMatch = (d: number) => { if (matchList.length) setMatchIdx((i) => (i + d + matchList.length) % matchList.length); };
  useEffect(() => {
    if (!q || matchList.length === 0) return;
    const t = window.setTimeout(() => {
      const cur = matchList[Math.min(matchIdx, matchList.length - 1)];
      document.querySelector(`[data-org-id="${CSS.escape(cur)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }, 80); // after force-opened ancestors render
    return () => window.clearTimeout(t);
  }, [q, matchList, matchIdx]);
  const currentMatch = q && matchList.length ? matchList[Math.min(matchIdx, matchList.length - 1)] : null;

  // Legend doubles as the colour key (dept accents were previously unexplained) and a filter:
  // selected depts stay full-opacity, everyone else dims. People view only.
  const deptLegend = useMemo(() => {
    if (view !== "people") return [];
    return [...deptHeadcount.entries()]
      .filter(([id]) => deptById.has(id))
      .map(([id, count]) => ({ id, count, name: deptById.get(id)!.display_name, color: leaveColor(undefined, id) }))
      .sort((a, b) => b.count - a.count);
  }, [view, deptHeadcount, deptById]);
  const toggleDeptFilter = (id: string) => setDeptFilter((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const dimmedByDept = (e?: Employee) => view === "people" && deptFilter.size > 0 && !(e?.department && deptFilter.has(idOf(e.department)));

  // Who is on approved leave right now - amber dot on their avatar while the overlay is on. Coverage is
  // whatever leave rows the caller may read (server narrows), which is the honest answer.
  const onLeaveToday = useMemo(() => {
    const s = new Set<string>();
    if (!showLeave) return s;
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    for (const l of leaves) {
      if ((l.state ?? "").toUpperCase() !== "APPROVED" || !l.employee) continue;
      if (l.start_date.slice(0, 10) <= today && today <= l.end_date.slice(0, 10)) s.add(idOf(l.employee));
    }
    return s;
  }, [showLeave, leaves]);

  // Open requisitions grouped under their hiring manager -> dashed "open role" ghost nodes.
  const vacByMgr = useMemo(() => {
    const m = new Map<string, JobRequisition[]>();
    if (!showVacancies) return m;
    for (const r of reqs) {
      if (r.status !== "open" || !r.hiring_manager) continue;
      const mgr = idOf(r.hiring_manager);
      if (!empById.has(mgr)) continue;
      const list = m.get(mgr) ?? [];
      list.push(r);
      m.set(mgr, list);
    }
    return m;
  }, [showVacancies, reqs, empById]);
  const openRoles = useMemo(() => [...vacByMgr.values()].flat().reduce((s, r) => s + (r.openings ?? 1), 0), [vacByMgr]);

  // Rasterize whichever layout is on screen (fonts are self-hosted and photos same-origin, so
  // html-to-image can inline everything). Lazy import keeps the lib out of the main bundle.
  const [exporting, setExporting] = useState(false);
  const exportChart = async (mode: "png" | "print") => {
    const el = document.querySelector<HTMLElement>("[data-org-canvas]");
    if (!el) return;
    setExporting(true);
    // Static output: hide interactive chrome (grips, move/focus buttons, carets) via [data-exporting]
    // CSS - visibility, not display, so nothing reflows - and prepend a title line for context.
    const width = el.scrollWidth;
    const header = document.createElement("div");
    header.style.cssText = `width:${width}px;text-align:center;padding:8px 0 20px;font-size:16px;font-weight:600;`;
    header.innerHTML = `${view === "people" ? "Org chart" : "Department structure"}<div style="font-size:12px;font-weight:400;color:hsl(var(--muted-foreground))">${nodes.size} ${view === "people" ? "people" : "departments"} · ${new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</div>`;
    el.setAttribute("data-exporting", "");
    el.prepend(header);
    try {
      const { toPng } = await import("html-to-image");
      const url = await toPng(el, { pixelRatio: 2, width, height: el.scrollHeight, backgroundColor: getComputedStyle(document.body).backgroundColor });
      if (mode === "png") {
        const a = document.createElement("a");
        a.href = url;
        a.download = `org-chart-${view}-${new Date().toISOString().slice(0, 10)}.png`;
        a.click();
      } else {
        const w = window.open("", "_blank");
        if (!w) { toast({ variant: "destructive", title: "Popup blocked", description: "Allow popups for this site to print the chart." }); return; }
        w.document.write(`<!doctype html><title>Org chart</title><img src="${url}" alt="Org chart" style="max-width:100%" onload="setTimeout(()=>{print();close()},60)">`);
        w.document.close();
      }
    } catch (e) {
      toast({ variant: "destructive", title: "Export failed", description: (e as Error).message });
    } finally {
      header.remove();
      el.removeAttribute("data-exporting");
      setExporting(false);
    }
  };

  const isOpen = (id: string) => forceOpen.has(id) || !collapsed.has(id);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const collapseAll = () => setCollapsed(new Set([...nodes.values()].filter((n) => n.childIds.length).map((n) => n.id)));
  const expandAll = () => setCollapsed(new Set());

  // Reveal one node: drop a focus that hides it, open its collapsed ancestors, scroll to it and flash a ring.
  const locate = (id: string) => {
    const trail: string[] = [];
    let p = nodes.get(id)?.parentId ?? null;
    while (p && !trail.includes(p)) { trail.push(p); p = nodes.get(p)?.parentId ?? null; }
    if (focusId && focusId !== id && !trail.includes(focusId)) setFocusId(null);
    setCollapsed((s) => { const n = new Set(s); for (const a of trail) n.delete(a); return n; });
    window.setTimeout(() => document.querySelector(`[data-org-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" }), 80);
    setFlashId(id);
    window.setTimeout(() => setFlashId((f) => (f === id ? null : f)), 2000);
  };
  const myId = view === "people" && me.employee_id && nodes.has(me.employee_id) ? me.employee_id : null;

  // Full-screen mode exits on Escape.
  useEffect(() => {
    if (!full) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [full]);

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

  // Quick profile peek. Everything shown is already in the cached employees collection - zero extra reads.
  function peekBody(id: string, e: Employee, n: TreeNode, total: number) {
    const badge = joinBadge(e);
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <PhotoAvatar employeeId={id} name={n.label} photo={e.photo} className="h-12 w-12" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
              {n.label}
              {badge && <JoinPill label={badge} />}
              {onLeaveToday.has(id) && <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">On leave</span>}
            </div>
            {e.job_title && <div className="truncate text-xs text-muted-foreground">{e.job_title}</div>}
            {e.employee_number && <div className="font-mono text-[11px] text-muted-foreground">{e.employee_number}</div>}
          </div>
        </div>
        <dl className="space-y-1.5 text-xs">
          {e.work_email && <div className="flex items-center gap-2"><dt className="w-14 shrink-0 text-muted-foreground">Email</dt><dd className="min-w-0 flex-1" title={e.work_email}><CopyEmail email={e.work_email} /></dd></div>}
          {e.department && <div className="flex items-center gap-2"><dt className="w-14 shrink-0 text-muted-foreground">Dept</dt><dd className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: deptColor(e.department) }} />{deptName(e.department)}</dd></div>}
          {e.manager && empById.has(idOf(e.manager)) && (
            <div className="flex items-center gap-2"><dt className="w-14 shrink-0 text-muted-foreground">Manager</dt><dd><button type="button" className="font-medium hover:underline" onClick={() => { setPeekId(null); locate(idOf(e.manager!)); }}>{empName(e.manager)}</button></dd></div>
          )}
          {e.start_date && <div className="flex items-center gap-2"><dt className="w-14 shrink-0 text-muted-foreground">Tenure</dt><dd>{tenureLabel(e.start_date)}</dd></div>}
          {n.childIds.length > 0 && <div className="flex items-center gap-2"><dt className="w-14 shrink-0 text-muted-foreground">Team</dt><dd>{n.childIds.length} direct{total !== n.childIds.length ? ` · ${total} total` : ""}</dd></div>}
        </dl>
        <div className="flex gap-1.5 pt-0.5">
          <Button size="sm" className="h-7 flex-1" onClick={() => navigate(`employees/${id}`)}>Open profile</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={() => { setPeekId(null); setFocusId(id); }} title="Focus on this subtree"><Crosshair className="h-3.5 w-3.5" /></Button>
          {canEdit && <Button size="sm" variant="outline" className="h-7" onClick={() => { setPeekId(null); setMoveFrom(id); }} title="Move…"><CornerDownRight className="h-3.5 w-3.5" /></Button>}
        </div>
      </div>
    );
  }

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
    const vac = view === "people" ? vacByMgr.get(id) ?? [] : [];
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
            "group/card relative w-[176px] rounded-xl border bg-card px-3 py-2.5 shadow-sm transition-all hover:shadow-md",
            matched && (id === currentMatch ? "ring-2 ring-primary" : "ring-1 ring-primary/50"), q && !matched && "opacity-60",
            dimmedByDept(e) && "opacity-35",
            flashId === id && "ring-2 ring-primary animate-pulse",
            // While dragging, fade everything that isn't a legal drop target (the dragged card, its current
            // parent, its descendants) so where you CAN drop is visible before you hover it.
            dragId === id && "opacity-40", dragId && dragId !== id && !validDrop(id) && "opacity-40",
            isDropOk && "ring-2 ring-emerald-500",
          )}
        >
          <div data-chrome className="absolute right-1 top-1 flex">
            {canEdit && <button type="button" onClick={() => setMoveFrom(id)} title="Move…" className="rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground"><CornerDownRight className="h-3.5 w-3.5" /></button>}
            <button type="button" onClick={() => setFocusId(id)} title="Focus on this subtree" className="rounded p-1 text-muted-foreground/60 hover:bg-accent hover:text-foreground"><Crosshair className="h-3.5 w-3.5" /></button>
          </div>
          {canEdit && (
            <span data-chrome title="Drag onto another card to move" className="absolute left-1 top-1/2 -translate-y-1/2 cursor-grab text-muted-foreground/30 transition-colors group-hover/card:text-muted-foreground/80">
              <GripVertical className="h-3.5 w-3.5" />
            </span>
          )}

          {view === "people" && e ? (
            <Popover open={peekId === id} onOpenChange={(o) => setPeekId(o ? id : null)}>
              <PopoverTrigger asChild>
                <button type="button" className="flex w-full flex-col items-center gap-1 text-center">
                  <span className="relative">
                    <PhotoAvatar employeeId={id} name={n.label} photo={e.photo} className="h-11 w-11" />
                    {onLeaveToday.has(id) && <span title="On approved leave today" className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-card bg-amber-500" />}
                  </span>
                  <span className="flex flex-wrap items-center justify-center gap-1 text-sm font-semibold leading-tight hover:underline">{n.label}{joinBadge(e) && <JoinPill label={joinBadge(e)!} />}</span>
                  {n.sub && <span className="text-xs text-muted-foreground">{n.sub}</span>}
                  {e.department && <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: accent }} />{deptName(e.department)}</span>}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-72" onOpenAutoFocus={(ev) => ev.preventDefault()}>{peekBody(id, e, n, total)}</PopoverContent>
            </Popover>
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
              {open ? <ChevronDown data-chrome className="h-3 w-3" /> : <ChevronRight data-chrome className="h-3 w-3" />}
              <Users className="h-3 w-3" /> {n.childIds.length}{total !== n.childIds.length ? ` · ${total}` : ""}
            </button>
          )}
        </div>
        </AccessItem>
        {(hasKids || vac.length > 0) && open && (
          <ul>
            {n.childIds.map((c) => renderNode(c, next))}
            {vac.map((r) => (
              <li key={r.path}>
                <button
                  type="button"
                  onClick={() => navigate("job-requisitions")}
                  title="Open requisition - view in Recruiting"
                  className="flex w-[176px] flex-col items-center gap-1 rounded-xl border-2 border-dashed border-amber-500/50 bg-amber-500/5 px-3 py-2.5 text-center transition-colors hover:border-amber-500"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400"><Briefcase className="h-5 w-5" /></span>
                  <span className="text-sm font-semibold leading-tight">{r.title}</span>
                  <span className="text-[11px] text-muted-foreground">Open role{(r.openings ?? 1) > 1 ? ` × ${r.openings}` : ""}{r.department ? ` · ${deptName(r.department)}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  }

  // Outline layout: the same nodes, collapse state, search, drag/drop and peek - just dense indented
  // rows, which read far better for deep or very wide orgs (and on phones).
  function renderRow(id: string, depth: number, seen: Set<string>): ReactNode {
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
    const badge = e ? joinBadge(e) : null;
    const vac = view === "people" ? vacByMgr.get(id) ?? [] : [];
    return (
      <div key={id}>
        <AccessItem collection={accessCol} objectPath={`${accessCol}/${id}`} can={accessRow?.access?.can} why={accessRow?.access?.why} label={n.label} iconClassName="absolute left-1 top-1/2 z-20 -translate-y-1/2 bg-card">
          <div
            data-org-id={id}
            draggable={canEdit}
            onDragStart={(ev) => { if (!canEdit) return; ev.dataTransfer.effectAllowed = "move"; setDragId(id); }}
            onDragEnd={() => { setDragId(null); setDropId(null); }}
            onDragOver={(ev) => { if (validDrop(id)) { ev.preventDefault(); setDropId(id); } }}
            onDragLeave={() => setDropId((d) => (d === id ? null : d))}
            onDrop={(ev) => { ev.preventDefault(); onDrop(id); }}
            style={{ paddingLeft: depth * 20 + 4 }}
            className={cn(
              "group/row flex items-center gap-2 rounded-md py-1 pr-2 transition-colors hover:bg-accent/50",
              matched && (id === currentMatch ? "ring-2 ring-primary" : "ring-1 ring-primary/50"), q && !matched && "opacity-60",
              dimmedByDept(e) && "opacity-35",
              flashId === id && "ring-2 ring-primary animate-pulse",
              dragId === id && "opacity-40", dragId && dragId !== id && !validDrop(id) && "opacity-40",
              isDropOk && "ring-2 ring-emerald-500",
            )}
          >
            {hasKids ? (
              <button type="button" onClick={() => toggle(id)} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
                {open ? <ChevronDown data-chrome className="h-3.5 w-3.5" /> : <ChevronRight data-chrome className="h-3.5 w-3.5" />}
              </button>
            ) : <span className="h-5 w-5 shrink-0" />}
            <span className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
            {view === "people" && e ? (
              <Popover open={peekId === id} onOpenChange={(o) => setPeekId(o ? id : null)}>
                <PopoverTrigger asChild>
                  <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className="relative shrink-0">
                      <PhotoAvatar employeeId={id} name={n.label} photo={e.photo} className="h-6 w-6" />
                      {onLeaveToday.has(id) && <span title="On approved leave today" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-amber-500" />}
                    </span>
                    <span className="truncate text-sm font-medium hover:underline">{n.label}</span>
                    {badge && <JoinPill label={badge} />}
                    {n.sub && <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{n.sub}</span>}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-72" onOpenAutoFocus={(ev) => ev.preventDefault()}>{peekBody(id, e, n, total)}</PopoverContent>
              </Popover>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded" style={{ backgroundColor: `${accent}22`, color: accent }}><Building2 className="h-3.5 w-3.5" /></span>
                <span className="truncate text-sm font-medium">{n.label}</span>
                {n.sub && <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{n.sub}</span>}
              </span>
            )}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {view === "departments" && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
                  {deptHeadcount.get(id) ?? 0} direct{(subtreeMembers.get(id) ?? 0) !== (deptHeadcount.get(id) ?? 0) ? ` · ${subtreeMembers.get(id) ?? 0} total` : ""}
                </span>
              )}
              {view === "people" && hasKids && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"><Users className="mr-0.5 inline h-3 w-3" />{n.childIds.length}{total !== n.childIds.length ? ` · ${total}` : ""}</span>}
              {canEdit && <button data-chrome type="button" onClick={() => setMoveFrom(id)} title="Move…" className="rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/row:opacity-100"><CornerDownRight className="h-3.5 w-3.5" /></button>}
              <button data-chrome type="button" onClick={() => setFocusId(id)} title="Focus on this subtree" className="rounded p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/row:opacity-100"><Crosshair className="h-3.5 w-3.5" /></button>
            </span>
          </div>
        </AccessItem>
        {hasKids && open && n.childIds.map((c) => renderRow(c, depth + 1, next))}
        {open && vac.map((r) => (
          <div key={r.path} style={{ paddingLeft: (depth + 1) * 20 + 4 }} className="flex items-center gap-2 py-1 pr-2">
            <span className="h-5 w-5 shrink-0" />
            <span className="h-4 w-1 shrink-0 rounded-full bg-amber-500/60" />
            <button type="button" onClick={() => navigate("job-requisitions")} title="Open requisition - view in Recruiting" className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-amber-500/15 text-amber-600 dark:text-amber-400"><Briefcase className="h-3.5 w-3.5" /></span>
              <span className="truncate text-sm font-medium text-muted-foreground hover:underline">{r.title}</span>
              <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">Open role{(r.openings ?? 1) > 1 ? ` × ${r.openings}` : ""}</span>
            </button>
          </div>
        ))}
      </div>
    );
  }

  const loading = view === "departments" && deptState === "loading";

  return (
    <div>
      <PageHeader
        title="Org Chart"
        description={canEdit ? "Drag a card onto another to change who it reports to, or use the move button. Click anyone for a quick profile peek." : "The reporting hierarchy and department structure. Click anyone for a quick profile peek."}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PageSettings me={me} host="org-chart" />
            {/* The People/Departments toggle is this page's tab bar - the collection-level access key rides on
                it (scoped to the active view), not on the page heading. */}
            <div className="flex items-center gap-1 rounded-md border p-0.5">
              <Button size="sm" variant={view === "people" ? "default" : "ghost"} className="h-7" onClick={() => { setView("people"); setFocusId(null); setDeptFilter(new Set()); setPeekId(null); }}><Network className="h-4 w-4" /> People</Button>
              <Button size="sm" variant={view === "departments" ? "default" : "ghost"} className="h-7" onClick={() => { setView("departments"); setFocusId(null); setDeptFilter(new Set()); setPeekId(null); }}><Building2 className="h-4 w-4" /> Departments</Button>
              <AccessTarget target={{ collection: view === "people" ? "employees" : "departments", label: view === "people" ? "People" : "Departments" }} className="ml-0.5 h-6 w-6" />
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") stepMatch(e.shiftKey ? -1 : 1); }} placeholder="Find someone…" className="h-9 w-48 pl-8" />
            </div>
            {myId && <Button size="sm" variant="outline" className="h-9" onClick={() => locate(myId)} title="Find me in the chart"><LocateFixed className="h-4 w-4" /> Me</Button>}
          </div>
        }
      />

      <TruncationNotice collection="employees" what="people" className="mb-3" />

      <DataState state={empState} error={empErr} onRetry={reloadEmp}>
        <Card className={cn(full && "fixed inset-0 z-50 overflow-auto rounded-none border-0")}>
          <CardContent className="p-4 sm:p-4">
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
                  <span className="flex items-center gap-1">
                    {q ? (
                      <>
                        {matches.size === 0 ? "0 matches" : `${Math.min(matchIdx, matches.size - 1) + 1} of ${matches.size} match${matches.size === 1 ? "" : "es"}`}
                        {matches.size > 1 && (
                          <>
                            <button type="button" onClick={() => stepMatch(-1)} title="Previous match" className="rounded p-0.5 hover:bg-accent hover:text-foreground"><ChevronUp className="h-3.5 w-3.5" /></button>
                            <button type="button" onClick={() => stepMatch(1)} title="Next match (Enter)" className="rounded p-0.5 hover:bg-accent hover:text-foreground"><ChevronDown className="h-3.5 w-3.5" /></button>
                          </>
                        )}
                      </>
                    ) : "Showing what you're allowed to see"}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {view === "people" && canSeeLeaves && (
                  <Button size="sm" variant={showLeave ? "secondary" : "outline"} className="h-7" onClick={() => setShowLeave((v) => !v)} title="Highlight who is on approved leave today">
                    <CalendarClock className="h-3.5 w-3.5" /> On leave{showLeave ? (leaveState === "loading" ? " …" : ` · ${onLeaveToday.size}`) : ""}
                  </Button>
                )}
                {view === "people" && canSeeReqs && (
                  <Button size="sm" variant={showVacancies ? "secondary" : "outline"} className="h-7" onClick={() => setShowVacancies((v) => !v)} title="Show open roles from Recruiting under their hiring managers">
                    <Briefcase className="h-3.5 w-3.5" /> Vacancies{showVacancies ? (reqState === "loading" ? " …" : ` · ${openRoles}`) : ""}
                  </Button>
                )}
                <div className="flex items-center rounded-md border p-0.5">
                  <Button size="sm" variant={layout === "tree" ? "secondary" : "ghost"} className="h-6 w-7 p-0" onClick={() => setLayout("tree")} title="Tree layout"><Network className="h-3.5 w-3.5" /></Button>
                  <Button size="sm" variant={layout === "list" ? "secondary" : "ghost"} className="h-6 w-7 p-0" onClick={() => setLayout("list")} title="Outline layout"><ListTree className="h-3.5 w-3.5" /></Button>
                </div>
                {layout === "tree" && (
                  <div className="flex items-center rounded-md border">
                    <button type="button" disabled={zi === 0} onClick={() => setZi((z) => Math.max(0, z - 1))} title="Zoom out" className="rounded-l-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"><ZoomOut className="h-3.5 w-3.5" /></button>
                    <button type="button" onClick={() => setZi(3)} title="Reset zoom" className="w-11 py-1 text-center text-[11px] font-medium tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground">{Math.round(ZOOMS[zi] * 100)}%</button>
                    <button type="button" disabled={zi === ZOOMS.length - 1} onClick={() => setZi((z) => Math.min(ZOOMS.length - 1, z + 1))} title="Zoom in" className="rounded-r-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"><ZoomIn className="h-3.5 w-3.5" /></button>
                  </div>
                )}
                <Button size="sm" variant="outline" className="h-7" onClick={expandAll}>Expand all</Button>
                <Button size="sm" variant="outline" className="h-7" onClick={collapseAll}>Collapse all</Button>
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => setFull((f) => !f)} title={full ? "Exit full screen (Esc)" : "Full screen"}>{full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</Button>
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={exporting} onClick={() => void exportChart("png")} title="Download as PNG"><ImageDown className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={exporting} onClick={() => void exportChart("print")} title="Print"><Printer className="h-3.5 w-3.5" /></Button>
              </div>
            </div>

            {/* Colour key + filter: one chip per department, click to spotlight (others dim). */}
            {deptLegend.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                {deptLegend.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => toggleDeptFilter(d.id)}
                    title={deptFilter.has(d.id) ? "Stop spotlighting this department" : "Spotlight this department"}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors hover:bg-accent",
                      deptFilter.has(d.id) ? "border-primary/60 bg-primary/10 font-medium" : "text-muted-foreground",
                    )}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} />
                    {d.name}
                    <span className="tabular-nums opacity-70">{d.count}</span>
                  </button>
                ))}
                {deptFilter.size > 0 && <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setDeptFilter(new Set())}><X className="h-3 w-3" /> Clear</Button>}
              </div>
            )}

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
              <CardsSkeleton count={3} />
            ) : displayRoots.length === 0 ? (
              <EmptyState icon={Network} title="Nothing to chart" description={view === "people" ? "No employees are visible to you." : "No departments defined yet."} />
            ) : layout === "tree" ? (
              <div data-org-canvas className="scroll-shadow-x [--scroll-ground:hsl(var(--card))] overflow-x-auto pb-2">
                <ul className="org-tree mx-auto w-max" style={{ zoom: ZOOMS[zi] }}>{displayRoots.map((id) => renderNode(id, new Set()))}</ul>
              </div>
            ) : (
              <div data-org-canvas className="space-y-0.5">{displayRoots.map((id) => renderRow(id, 0, new Set()))}</div>
            )}
          </CardContent>
        </Card>
      </DataState>

      {moveFrom && (
        <MovePicker
          title={view === "people" ? "Change manager" : "Change parent department"}
          description={
            view === "people"
              ? "The new manager approves their requests and sees them in team views. Anyone reporting to them moves along with them."
              : "Re-parenting moves the whole sub-tree: child departments, their people, and the access rules scoped to them."
          }
          subjectLabel={nodes.get(moveFrom)?.label ?? ""}
          currentLabel={(() => {
            const p = nodes.get(moveFrom)?.parentId;
            return p ? nodes.get(p)?.label ?? "-" : view === "people" ? "no manager" : "no parent";
          })()}
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
function MovePicker({ title, description, subjectLabel, currentLabel, topLevelLabel, candidates, onPick, onClose }: {
  title: string;
  description: string;
  subjectLabel: string;
  // Where the subject sits today, so the move reads as a change rather than a bare choice.
  currentLabel: string;
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
      {/* Enter picks the single remaining match: typing three letters and pressing Enter is how a picker with
          a search box is expected to behave, and it beats reaching for the mouse mid-reorg. */}
      <DialogContent onEnterSubmit={() => { if (filtered.length === 1) onPick(filtered[0]!.id); }}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <p className="-mt-1 flex flex-wrap items-baseline gap-1.5 text-sm text-muted-foreground">
          Moving <span className="font-medium text-foreground">{subjectLabel}</span>, currently under <span className="font-medium text-foreground">{currentLabel}</span>.
        </p>
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" autoFocus />
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
        {candidates.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {ql ? `${filtered.length} of ${candidates.length} shown.` : `${candidates.length} to choose from.`} Their own reports move with them.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
