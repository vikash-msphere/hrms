import * as React from "react";
import { KeyRound, Trash2, Plus, ShieldCheck, ArrowLeft, Zap, Globe, Waypoints, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { create, listAll, remove } from "@/api";
import { fetchAllAccessRules, scopeText, permText } from "./permMatrix";
import { usePaged, Pager } from "@/components/common/Pager";
import { roleLabel, EVERYONE_ROLE } from "@/lib/roles";
import type { User } from "@/types";
import type { AccessTargetRef } from "./AccessModeProvider";
import { ruleScopeFor, ruleMatchesTarget } from "./accessRuleScope";
import { customMethodsFor } from "./customMethods";
import { scopesForCollection, fetchScopeCapabilities } from "./permMatrix";
import { metaFor } from "./collectionMeta";
import { verbInfo } from "./verbMeta";
import { PreviewPanel, fetchPreview } from "./PreviewPanel";
import { usePermission } from "@/lib/perm";

// One access rule (the unified resource). Roles and users are the same primitive.
type AccessRule = {
  path: string;
  subject_kind: "role" | "user";
  subject: string; // role name, or users/<id>
  collection: string;
  scope: string; // all | self | dept | subtree | exact
  scope_ref?: string;
  field?: string;
  level?: string;
  verb?: string;
  effect: string; // allow | deny
  etag?: string;
};
type Role = { path: string; name: string };

// Standard-method levels (the read<write<admin ladder). `none` = remove the rule; `deny` blocks the object.
const LEVELS = ["read", "write", "admin", "deny"] as const;

// Human label for the scope provenance (access.why) - WHY the caller can see this object, by scope of the
// granting rule. Subject (role/user) is not recoverable from the flattened runtime grant, so scope is the
// honest answer the modal shows.
const WHY_LABEL: Record<string, string> = {
  self: "your own record",
  dept: "your department",
  subtree: "your org subtree",
  exact: "a rule on this object",
  all: "an org-wide rule",
};
// Custom-method effects (no ladder; fail-closed): `none` = no rule (denied), allow, or deny (wins).
const VERB_EFFECTS = ["none", "allow", "deny"] as const;
// Wildcard verb sentinel = ALL custom methods in one rule (matches the engine's `*` verb token).
const ALL_VERBS = "*";

export function AclModal({
  target,
  onClose,
  canManageUsers,
  canManageRoles,
}: {
  target: AccessTargetRef | null;
  onClose: () => void;
  canManageUsers: boolean;
  canManageRoles: boolean;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [rules, setRules] = React.useState<AccessRule[]>([]);
  const [users, setUsers] = React.useState<User[]>([]);
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [addUser, setAddUser] = React.useState("");
  const [addAccess, setAddAccess] = React.useState("read"); // level (read|write|admin|deny) or verb effect (allow|deny)
  // Opened on an object/collection (no target.verb), the admin can drill into one custom method; `focusVerb`
  // is that drill-in. A verb-target (an action element) sets the verb directly and skips the chips.
  const [focusVerb, setFocusVerb] = React.useState<string | undefined>(undefined);
  // Which scope tier the rule applies at (chips below): "exact" (this object), "self" (own), "dept", or "all".
  // The grant is exactly as narrow as the chosen chip; the option set + narrowest-first default come from the
  // central scopesForCollection.
  const [scopeSel, setScopeSel] = React.useState("all");
  // Per-collection grantable scope tiers from the policy manifest (carried on users/me). Fetched once + cached
  // in permMatrix, so opening successive icons reuses it. Empty until loaded -> the target collapses to "all".
  const [scopeCaps, setScopeCaps] = React.useState<Record<string, string[]>>({});
  React.useEffect(() => {
    fetchScopeCapabilities().then(setScopeCaps).catch(() => setScopeCaps({}));
  }, []);

  const objectPath = target?.objectPath;
  const collection = target?.collection;
  const field = target?.field;
  const activeVerb = target?.verb ?? focusVerb;
  const verbMode = !!activeVerb;
  // Create mode: a "new <X>" affordance manages the collection-level CREATE gate (1-token `<collection>`
  // write) - who may create, separate from who may write existing objects. Always collection-scoped (no
  // object/field/verb), so the only meaningful level is write, framed "can create".
  const createMode = !!target?.create;
  const hasObject = !!objectPath;
  const hasField = !!field;
  // Scope chips apply to object/collection, field, and verb targets alike - a field rule is scoped exactly like
  // an object one (this object / own / dept / all), the field token just rides along. Only the create gate has a
  // fixed scope. Narrowest first, so the default selection is the tightest available.
  const scopeOpts = !createMode ? scopesForCollection(collection ?? "", hasObject, scopeCaps) : [];
  // Default to the narrowest scope when the target identity changes (new icon opened) or the caps finish
  // loading; keep the current selection if it's still a valid option (don't yank a choice mid-edit).
  React.useEffect(() => {
    setScopeSel((cur) => (scopeOpts.some((o) => o.value === cur) ? cur : scopeOpts[0]?.value ?? "all"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, objectPath, field, createMode, activeVerb, scopeCaps]);
  // Custom methods offered for this target: the collection's methods, shown as drill-in chips for an
  // object/collection target (a pure field target manages a level, not a method; a verb-target is already focused).
  const collectionVerbs = customMethodsFor(collection ?? "");
  const showVerbChips = !target?.verb && !hasField && !createMode && collectionVerbs.length > 0;
  // The level options offered: in create mode the only meaningful grant is write (= may create), shown as
  // "can create"; otherwise the full read/write/admin ladder. `none` always means "remove the rule".
  const levelChoices: readonly string[] = createMode ? ["write"] : [...LEVELS];
  // Display labels for the standard ladder. The engine value `admin` is shown as "full" so it reads as a
  // superset (delete + purge) rather than a separate sibling of read/write that hides delete. Value unchanged.
  const levelLabel = (l: string) => (createMode && l === "write" ? "can create" : l === "admin" ? "full" : l);

  const showUsers = canManageUsers;
  const showRoles = canManageRoles;
  const defaultTab = (hasObject && showUsers) || !showRoles ? "users" : "roles";

  const reload = React.useCallback(async () => {
    if (!target) return;
    setBusy(true);
    try {
      const tasks: Promise<unknown>[] = [fetchAllAccessRules().then((r) => setRules(r as AccessRule[]))];
      if (showUsers) tasks.push(listAll<User>("users").then(setUsers));
      if (showRoles) tasks.push(listAll<Role>("roles").then(setRoles));
      await Promise.all(tasks);
    } catch (e) {
      toast({ variant: "destructive", title: "Could not load access", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }, [target, showUsers, showRoles, toast]);

  React.useEffect(() => {
    if (target) void reload();
    setFocusVerb(undefined);
    setAddUser("");
  }, [target, reload]);
  // Keep the add-form's access value valid for the current mode (levels vs verb effects).
  React.useEffect(() => {
    setAddAccess(verbMode ? "allow" : createMode ? "write" : "read");
  }, [verbMode, activeVerb, createMode]);

  // target -> rule scope + scope matching are pure + unit-tested (./accessRuleScope). Matching ignores the
  // verb dimension, so we partition the matched rules here: level/deny rules have no verb; a verb's rule is
  // the one whose `verb` equals it.
  const t = { collection: collection ?? "", objectPath, field, create: createMode, scope: scopeSel };
  const matchesTarget = (r: AccessRule) => ruleMatchesTarget(r, t);
  const scopeBody = (): Record<string, unknown> => ruleScopeFor(t) as Record<string, unknown>;

  const levelBody = (lvl: string): Record<string, unknown> => (lvl === "deny" ? { effect: "deny" } : { level: lvl });
  const verbBody = (v: string, effect: "allow" | "deny"): Record<string, unknown> => ({ verb: v, effect });

  const roleAll = (name: string) => rules.filter((r) => r.subject_kind === "role" && r.subject === name && matchesTarget(r));
  // Same subject + same target dimension, but at ANOTHER scope tier - shown as context so "HR already has
  // write on ALL leave requests" is visible while authoring a narrower (or duplicate) rule here.
  const otherScopeRules = (subjectKind: "role" | "user", subject: string) =>
    rules.filter(
      (r) =>
        r.subject_kind === subjectKind &&
        r.subject === subject &&
        r.collection === collection &&
        r.scope !== "create" &&
        (r.field ?? undefined) === (field ?? undefined) &&
        (verbMode ? r.verb === activeVerb : !r.verb) &&
        !matchesTarget(r),
    );
  const roleLevelCurrent = (name: string): string => {
    const rs = roleAll(name).filter((r) => !r.verb);
    if (rs.some((r) => r.effect === "deny")) return "deny";
    return rs.find((r) => r.effect === "allow")?.level ?? "none";
  };
  const roleVerbCurrent = (name: string, v: string): string => roleAll(name).find((r) => r.verb === v)?.effect ?? "none";

  const userMatched = rules.filter((r) => r.subject_kind === "user" && matchesTarget(r));
  const userShown = verbMode ? userMatched.filter((r) => r.verb === activeVerb) : userMatched.filter((r) => !r.verb);
  const emailOf = (subject: string) => users.find((u) => u.path === subject)?.email ?? subject;

  // Paginate the in-modal lists so a long role catalog / many per-user rules don't overflow the dialog.
  // Pin the reserved "everyone" subject to the top - it's the "allow everyone" primitive, the common reach.
  const sortedRoles = React.useMemo(
    () => [...roles].sort((a, b) => (a.name === EVERYONE_ROLE ? -1 : b.name === EVERYONE_ROLE ? 1 : 0)),
    [roles],
  );
  // Filter boxes appear once a list outgrows one page - paging alone makes a long catalog unscannable.
  const [roleFilter, setRoleFilter] = React.useState("");
  const [userFilter, setUserFilter] = React.useState("");
  const shownRoles = React.useMemo(() => {
    const q = roleFilter.trim().toLowerCase();
    return q ? sortedRoles.filter((r) => roleLabel(r.name).toLowerCase().includes(q) || r.name.includes(q)) : sortedRoles;
  }, [sortedRoles, roleFilter]);
  const shownUserRules = React.useMemo(() => {
    const q = userFilter.trim().toLowerCase();
    return q ? userShown.filter((r) => emailOf(r.subject).toLowerCase().includes(q)) : userShown;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userShown, userFilter, users]);
  const rolePaged = usePaged(shownRoles, 8);
  const userPaged = usePaged(shownUserRules, 8);

  // Impact line for a destructive change (deny / rule removal): ask the engine how many people can do the
  // target thing RIGHT NOW, so the confirm dialog states what is being taken away instead of a bare "sure?".
  // Preview-capability holders only; everyone else keeps the plain confirm (fail quiet, never block).
  const canPreview = usePermission("access-rules.preview");
  async function impactLine(): Promise<string | undefined> {
    if (!canPreview || !collection) return undefined;
    try {
      const pool = users.length ? users : await listAll<User>("users");
      const verbAsk = activeVerb && activeVerb !== ALL_VERBS ? activeVerb : undefined;
      const verdicts = await fetchPreview(
        { collection, object: objectPath, field, verb: verbAsk },
        pool.slice(0, 100).map((u) => u.path),
      );
      const n = verdicts.filter((v) => (verbAsk ? v.verb_allowed : createMode ? v.write : v.read)).length;
      const what = verbAsk ? `use "${verbAsk}" here` : createMode ? "create here" : "see this";
      return n > 0 ? `Right now ${n} ${n === 1 ? "person" : "people"} can ${what}. A deny wins over every allow, and removing a rule can take access away.` : undefined;
    } catch {
      return undefined;
    }
  }

  async function setRoleLevel(name: string, value: string) {
    if (value === "deny") {
      const ok = await confirm({ title: `Deny ${roleLabel(name)} here?`, description: await impactLine(), destructive: true, confirmLabel: "Deny" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      for (const r of roleAll(name).filter((x) => !x.verb)) await remove(r.path, r.etag); // edit = delete + create
      if (value !== "none") await create("access-rules", { subject_kind: "role", subject: name, collection, ...scopeBody(), ...levelBody(value) });
      toast({ title: `Updated ${roleLabel(name)}` });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not update role", description: String((e as Error).message) });
      setBusy(false);
    }
  }

  async function setRoleVerb(name: string, v: string, value: string) {
    if (value === "deny") {
      const ok = await confirm({ title: `Deny ${roleLabel(name)} the "${v}" method here?`, description: await impactLine(), destructive: true, confirmLabel: "Deny" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      for (const r of roleAll(name).filter((x) => x.verb === v)) await remove(r.path, r.etag);
      if (value !== "none") await create("access-rules", { subject_kind: "role", subject: name, collection, ...scopeBody(), ...verbBody(v, value as "allow" | "deny") });
      toast({ title: `Updated ${roleLabel(name)} · ${v}` });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not update role", description: String((e as Error).message) });
      setBusy(false);
    }
  }

  // One-click canonical rule bundles on the Everyone role - the patterns admins hand-assemble over and
  // over (open a kudos wall, open a suggestion box). Additive only: existing rules stay, a deny still wins,
  // and rules that already exist are skipped.
  async function applyPreset(kind: "view" | "openBox" | "selfService") {
    const defs: Record<string, { title: string; desc: string; rules: { scope: string; level: string }[] }> = {
      view: { title: `Open ${plural} to everyone?`, desc: "Adds: Everyone can read all. Use for org-wide read-only surfaces.", rules: [{ scope: "all", level: "read" }] },
      openBox: { title: `Let everyone add + see all ${plural}?`, desc: "Adds: Everyone can create, and read every entry. The open-wall pattern (kudos, announcements).", rules: [{ scope: "create", level: "write" }, { scope: "all", level: "read" }] },
      selfService: { title: `Let everyone add + manage their own ${plural}?`, desc: "Adds: Everyone can create, and read/edit only their own entries. The self-service pattern (requests, suggestions).", rules: [{ scope: "create", level: "write" }, { scope: "self", level: "write" }] },
    };
    const def = defs[kind]!;
    const ok = await confirm({ title: def.title, description: `${def.desc} Existing rules stay untouched; an explicit deny still wins.`, confirmLabel: "Apply" });
    if (!ok) return;
    setBusy(true);
    try {
      for (const r of def.rules) {
        const exists = rules.some(
          (x) => x.subject_kind === "role" && x.subject === EVERYONE_ROLE && x.collection === collection && x.scope === r.scope && !x.field && !x.verb && x.effect === "allow" && (r.scope === "create" || x.level === r.level),
        );
        if (!exists) await create("access-rules", { subject_kind: "role", subject: EVERYONE_ROLE, collection, scope: r.scope, level: r.level });
      }
      toast({ title: "Preset applied" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't apply the preset", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function addUserRule() {
    if (!addUser) return;
    setBusy(true);
    try {
      const body = verbMode ? verbBody(activeVerb!, addAccess === "deny" ? "deny" : "allow") : levelBody(addAccess);
      await create("access-rules", { subject_kind: "user", subject: addUser, collection, ...scopeBody(), ...body });
      toast({ title: "Access updated" });
      setAddUser("");
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not grant access", description: String((e as Error).message) });
      setBusy(false);
    }
  }

  async function removeRule(r: AccessRule) {
    const ok = await confirm({ title: "Remove this access rule?", description: await impactLine(), destructive: true, confirmLabel: "Remove" });
    if (!ok) return;
    setBusy(true);
    try {
      await remove(r.path, r.etag);
      toast({ title: "Access rule removed" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not remove", description: String((e as Error).message) });
      setBusy(false);
    }
  }

  // Human context for the collection: curated label/nouns plus a note that answers "what does granting
  // this actually do?" - critical for the virtual capabilities (export, activity) where the auto-derived
  // noun ("all export") says nothing about their app-wide semantics.
  const meta = metaFor(collection ?? "");
  const { singular, plural } = meta;
  // The object the rule lands on, in words. `target.label` is a real object name ONLY for a plain object
  // target; for a field/verb target it's the field/verb name, so fall back to a generic "this <singular>".
  const objectName = hasObject && !hasField && !verbMode ? (target?.label ?? `this ${singular}`) : `this ${singular}`;
  const whereNote =
    scopeSel === "exact" ? objectName
    : scopeSel === "subtree" ? `${objectName} & below`
    : scopeSel === "self" ? `their own ${plural}`
    : scopeSel === "dept" ? `their department's ${plural}`
    : meta.allPhrase ?? `all ${plural}`;
  const scopeNote = createMode
    ? `creating a new ${singular}`
    : verbMode
    ? `${activeVerb === ALL_VERBS ? "all methods" : `"${verbInfo(collection ?? "", activeVerb!).label}"`} on ${whereNote}`
    : hasField
    ? `the "${target?.label ?? field}" field of ${whereNote}`
    : whereNote;

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-600 dark:text-amber-400" /> Manage access · {meta.label}
          </DialogTitle>
          <DialogDescription>
            {createMode ? (
              <>
                Who can create a new <code className="rounded bg-muted px-1">{singular}</code>
              </>
            ) : verbMode ? (
              <>
                Who can {activeVerb === ALL_VERBS ? "use any method" : <>{verbInfo(collection ?? "", activeVerb!).label.toLowerCase()} (<code className="rounded bg-muted px-1">{activeVerb}</code>)</>} on {whereNote}
              </>
            ) : hasField ? (
              <>
                Who can see or edit <code className="rounded bg-muted px-1">{target?.label ?? field}</code> on {whereNote}
              </>
            ) : (
              <>Who can see or change {whereNote}</>
            )}
            {target?.can && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5" /> you can: {target.can.length ? target.can.join(", ") : "-"}
              </span>
            )}
            {target?.why && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground" title="The scope of the rule that grants your access (not which role).">
                <Waypoints className="h-3.5 w-3.5" /> via {WHY_LABEL[target.why]}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {/* What granting this actually does - the answer to "does export apply to every table or this one?",
            "why can't I pick a department here?". Only collections with real ambiguity carry a note. */}
        {meta.note && (
          <p className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 p-2.5 text-xs text-muted-foreground">
            <Info className="mt-px h-3.5 w-3.5 shrink-0 text-primary" />
            <span>{meta.note}</span>
          </p>
        )}

        {/* Scope: how broadly the rule applies - this object, the subject's own / department rows, or the
            whole collection. Options + narrowest-first default come from the central scopesForCollection
            (backend policy manifest), so every access icon offers the same (relevant) choices. When only one
            tier exists, say so instead of showing a lone pre-selected chip that looks like a broken picker. */}
        {scopeOpts.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/30 p-2">
            <span className="mr-1 text-xs font-medium text-muted-foreground">Scope:</span>
            {scopeOpts.map((s) => (
              <Button key={s.value} variant={scopeSel === s.value ? "default" : "outline"} size="sm" className="h-7" onClick={() => setScopeSel(s.value)}>
                {s.value === "exact" ? `This ${singular}` : s.value === "subtree" ? `This ${singular} & below` : s.label}
              </Button>
            ))}
          </div>
        ) : (
          (() => {
            const [value, why] = createMode
              ? ["org-wide", `creating applies to the whole ${meta.label.toLowerCase()} collection.`]
              : meta.kind === "virtual"
                ? ["org-wide", "this is an app-wide capability with no narrower tiers."]
                : meta.kind === "settings" && !hasObject
                  ? ["all settings sections", "open a specific section's gear to scope a rule to just that section."]
                  : [scopeOpts[0]?.value === "exact" ? objectName : `all ${plural}`, "the only tier this resource supports."];
            return (
              <p className="rounded-md border bg-muted/30 p-2 text-xs text-muted-foreground">
                <span className="font-medium">Scope:</span> <span className="font-semibold text-foreground">{value}</span> - {why}
              </p>
            );
          })()
        )}

        {/* Canonical rule bundles for a plain collection target - one click instead of hand-assembling the
            same open-wall / self-service rules on every engagement collection. */}
        {showRoles && !hasObject && !hasField && !verbMode && !createMode && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed bg-muted/20 p-2">
            <span className="mr-1 text-xs font-medium text-muted-foreground">Presets:</span>
            <Button variant="outline" size="sm" className="h-7" disabled={busy} title="Everyone can read all entries." onClick={() => void applyPreset("view")}>Everyone can view</Button>
            <Button variant="outline" size="sm" className="h-7" disabled={busy} title="Everyone can create, and read every entry (open wall)." onClick={() => void applyPreset("openBox")}>Everyone adds + sees all</Button>
            {scopeOpts.some((o) => o.value === "self") && (
              <Button variant="outline" size="sm" className="h-7" disabled={busy} title="Everyone can create, and read/edit only their own entries (self-service)." onClick={() => void applyPreset("selfService")}>Everyone adds + sees own</Button>
            )}
          </div>
        )}

        {/* Ground truth: what the engine actually answers for a chosen person on this target. */}
        {target && <PreviewPanel target={{ ...target, verb: undefined }} activeVerb={activeVerb} createMode={createMode} />}

        {/* Custom-method navigation: step back from a drilled-in method, or drill into one. */}
        {focusVerb && !target?.verb && (
          <Button variant="ghost" size="sm" className="w-fit" onClick={() => setFocusVerb(undefined)}>
            <ArrowLeft className="h-4 w-4" /> Back to standard access
          </Button>
        )}
        {showVerbChips && !focusVerb && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/30 p-2">
            <span className="mr-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Zap className="h-3.5 w-3.5" /> Custom methods:
            </span>
            {/* Grant/deny ALL custom methods in one rule (verb `*`) instead of picking each individually. */}
            <Button variant="secondary" size="sm" className="h-7" onClick={() => setFocusVerb(ALL_VERBS)}>
              All methods
            </Button>
            {collectionVerbs.map((v) => {
              const info = verbInfo(collection ?? "", v);
              return (
                <Button key={v} variant="outline" size="sm" className="h-7" title={info.description ?? v} onClick={() => setFocusVerb(v)}>
                  {info.label}
                </Button>
              );
            })}
          </div>
        )}

        <Tabs defaultValue={defaultTab}>
          <TabsList>
            {showUsers && <TabsTrigger value="users">Users</TabsTrigger>}
            {showRoles && <TabsTrigger value="roles">Roles</TabsTrigger>}
          </TabsList>

          {showUsers && (
            <TabsContent value="users" className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Per-user access on {scopeNote}. {verbMode ? "A custom method is denied unless explicitly allowed; a deny always wins." : "A deny always wins."}
                {!verbMode && !createMode && " Levels nest: read ⊂ write ⊂ full (full = delete + purge)."}
              </p>
              {userShown.length > 8 && <Input className="h-8" placeholder="Filter by email…" value={userFilter} onChange={(e) => setUserFilter(e.target.value)} />}
              <div className="space-y-2">
                {userShown.length === 0 && <p className="text-sm text-muted-foreground">No per-user rules here.</p>}
                {userShown.length > 0 && shownUserRules.length === 0 && <p className="text-sm text-muted-foreground">No rule matches "{userFilter}".</p>}
                {userPaged.pageItems.map((r) => (
                  <div key={r.path} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{emailOf(r.subject)}</span>
                      {(() => {
                        const others = otherScopeRules("user", r.subject);
                        return others.length > 0 ? (
                          <span className="truncate text-[11px] text-muted-foreground" title="This person's rules on the same target at other scope tiers.">
                            also: {others.map((o) => `${scopeText(o)} · ${permText(o)}`).join(", ")}
                          </span>
                        ) : null;
                      })()}
                    </span>
                    <div className="flex items-center gap-2">
                      <Badge variant={r.effect === "deny" ? "destructive" : "secondary"}>{r.effect === "deny" ? "deny" : r.verb ? verbInfo(collection ?? "", r.verb).label : createMode ? "can create" : levelLabel(r.level ?? "allow")}</Badge>
                      <Button variant="ghost" size="icon" disabled={busy} onClick={() => removeRule(r)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <Pager page={userPaged.page} totalPages={userPaged.totalPages} total={userPaged.total} onPage={userPaged.setPage} />
              <div className="flex items-end gap-2 border-t pt-3">
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-medium">User</label>
                  <Combobox value={addUser} onValueChange={setAddUser} options={users.map((u) => ({ value: u.path, label: u.email }))} placeholder="Search people…" />
                </div>
                <div className="w-32">
                  <label className="mb-1 block text-xs font-medium">{verbMode ? "Effect" : createMode ? "Create" : "Access"}</label>
                  <Select value={addAccess} onValueChange={setAddAccess}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(verbMode ? (activeVerb === ALL_VERBS ? ["allow"] : ["allow", "deny"]) : levelChoices).map((l) => (
                        <SelectItem key={l} value={l}>
                          {verbMode ? l : levelLabel(l)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button disabled={busy || !addUser} onClick={addUserRule}>
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>
            </TabsContent>
          )}

          {showRoles && (
            <TabsContent value="roles" className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Access per role on {scopeNote} (one rule per role). {verbMode && "Allowed only with an explicit allow; a deny wins."}
                {!verbMode && !createMode && " Levels nest: read ⊂ write ⊂ full (full = delete + purge)."}
              </p>
              {sortedRoles.length > 8 && <Input className="h-8" placeholder="Filter roles…" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} />}
              <div className="space-y-2">
                {sortedRoles.length > 0 && shownRoles.length === 0 && <p className="text-sm text-muted-foreground">No role matches "{roleFilter}".</p>}
                {rolePaged.pageItems.map((role) => {
                  const isEveryone = role.name === EVERYONE_ROLE;
                  return (
                  <div
                    key={role.name}
                    className={cn(
                      "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
                      isEveryone && "border-indigo-300 bg-indigo-50 dark:border-indigo-900 dark:bg-indigo-950/40",
                    )}
                  >
                    {(() => {
                      const others = otherScopeRules("role", role.name);
                      const alsoNote = others.length > 0 && (
                        <span className="text-[11px] text-muted-foreground" title="Rules for this role on the same target at other scope tiers.">
                          also: {others.map((o) => `${scopeText(o)} · ${permText(o)}`).join(", ")}
                        </span>
                      );
                      return isEveryone ? (
                        <span className="flex flex-col">
                          <span className="flex items-center gap-2">
                            <Globe className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                            <span className="font-medium text-indigo-700 dark:text-indigo-300">Everyone</span>
                            <span className="text-xs text-muted-foreground">all signed-in users</span>
                          </span>
                          {alsoNote}
                        </span>
                      ) : (
                        <span className="flex flex-col">
                          <span>{roleLabel(role.name)}</span>
                          {alsoNote}
                        </span>
                      );
                    })()}
                    {verbMode ? (
                      <Select value={roleVerbCurrent(role.name, activeVerb!)} onValueChange={(v) => setRoleVerb(role.name, activeVerb!, v)} disabled={busy}>
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(activeVerb === ALL_VERBS ? (["none", "allow"] as const) : VERB_EFFECTS).map((l) => (
                            <SelectItem key={l} value={l}>
                              {l}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select value={roleLevelCurrent(role.name)} onValueChange={(v) => setRoleLevel(role.name, v)} disabled={busy}>
                        <SelectTrigger className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">{createMode ? "cannot create" : "none"}</SelectItem>
                          {levelChoices.map((l) => (
                            <SelectItem key={l} value={l}>
                              {levelLabel(l)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                  );
                })}
              </div>
              <Pager page={rolePaged.page} totalPages={rolePaged.totalPages} total={rolePaged.total} onPage={rolePaged.setPage} />
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
