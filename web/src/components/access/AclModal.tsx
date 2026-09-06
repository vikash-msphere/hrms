import * as React from "react";
import { KeyRound, Trash2, Plus, ShieldCheck, ArrowLeft, Zap, Globe, Waypoints, Info, AlertTriangle, Clock, History, Check, X, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/activity";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { api, create, invoke, listAll, remove } from "@/api";
import { fetchAllAccessRules, scopeText, permText, accessTone, type AccessRule } from "./permMatrix";
import { ruleSentence, expiryLabel, denyBlocking } from "./ruleLogic";
import { usePaged, Pager } from "@/components/common/Pager";
import { roleLabel, EVERYONE_ROLE } from "@/lib/roles";
import type { Employee, User } from "@/types";
import type { AccessTargetRef } from "./AccessModeProvider";
import { ruleScopeFor, ruleMatchesTarget } from "./accessRuleScope";
import { customMethodsFor } from "./customMethods";
import { scopesForCollection, fetchScopeCapabilities } from "./permMatrix";
import { metaFor } from "./collectionMeta";
import { verbInfo } from "./verbMeta";
import { PreviewPanel, fetchPreview } from "./PreviewPanel";
import { usePermission } from "@/lib/perm";

// The rule shape is the shared one (permMatrix) - roles and users are the same primitive, and the matrix,
// the fine-rules editor and this modal all read the same fields, lifecycle included.
type Role = { path: string; name: string };

// One audit entry about an access rule, for "added by X, 2w ago" and the recent-changes strip. Read from the
// audit trail the server already writes on every rule create/delete/approve - no new bookkeeping.
type RuleEvent = { path: string; action: string; actor_name?: string; actor_email?: string; create_time: string; meta?: { rule_id?: string; collection?: string; sentence?: string } };

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

// The trigger's default `[&>span]:line-clamp-1` turns the value slot into a -webkit-box, which fights the
// dot+label row: keep it a single flex line and give the control WIDTH (w-40 fits "cannot create") instead of
// letting it grow a second row.
const ACCESS_TRIGGER = "[&>span]:flex [&>span]:items-center [&>span]:line-clamp-none";

// Every access dropdown option renders as a coloured dot + coloured label - a grant and a no-grant must not
// look alike at a glance ("can create" vs "cannot create" was the worst offender). Radix clones the SELECTED
// item's children into the trigger, so this one component styles both the open menu and the closed control.
function AccessOptionLabel({ value, label, createMode }: { value: string; label: string; createMode: boolean }) {
  const tone = accessTone(value, createMode);
  return (
    // inline-flex + nowrap: the trigger is a fixed-width one-liner, so the dot+label must never wrap onto a
    // second row (that grew the control's height instead of its width).
    <span className={cn("inline-flex items-center gap-2 whitespace-nowrap font-medium", tone.text)}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot)} />
      {label}
    </span>
  );
}

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
  // employees/{id} -> display name, so the people picker reads "Priya Nair · priya.nair@acme.com" rather than a
  // column of raw addresses. Every employee has an account (services/employees.ts provisions one at create), so
  // this list is as long as the company and a name is what somebody actually searches by.
  const [names, setNames] = React.useState<Record<string, string>>({});
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [busy, setBusy] = React.useState(false);
  // Bulk grant: the add form collects a LIST of people (chips) and writes one rule each, because granting the
  // same access to five people was five open-pick-add cycles.
  const [addUsers, setAddUsers] = React.useState<string[]>([]);
  // Optional expiry on what is being granted (contractor / temporary access). "" = permanent.
  const [addExpires, setAddExpires] = React.useState("");
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
  // Bumped after every rule reload -> the preview panel re-asks the engine for the person it is showing.
  const [rulesVersion, setRulesVersion] = React.useState(0);
  // Recent access-rule changes from the audit trail: who authored which rule and when. Loaded once per open
  // (best-effort - a caller without the audit capability simply gets no provenance, never an error).
  const [events, setEvents] = React.useState<RuleEvent[]>([]);
  const [showHistory, setShowHistory] = React.useState(false);
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
  // Bound to this modal's mode so the call sites stay short (see the hoisted AccessOption below).
  const AccessOption = ({ value, label }: { value: string; label: string }) => <AccessOptionLabel value={value} label={label} createMode={createMode} />;

  const showUsers = canManageUsers;
  const showRoles = canManageRoles;
  const defaultTab = (hasObject && showUsers) || !showRoles ? "users" : "roles";

  const reload = React.useCallback(async () => {
    if (!target) return;
    setBusy(true);
    try {
      const tasks: Promise<unknown>[] = [fetchAllAccessRules().then((r) => setRules(r as AccessRule[]))];
      if (showUsers) {
        tasks.push(listAll<User>("users").then(setUsers));
        tasks.push(
          listAll<Employee>("employees").then((emps) =>
            setNames(Object.fromEntries(emps.map((e) => [e.path, `${e.first_name} ${e.last_name}`.trim()]))),
          ),
        );
      }
      if (showRoles) tasks.push(listAll<Role>("roles").then(setRoles));
      await Promise.all(tasks);
      // Every rule mutation funnels through reload(), so this counter is the modal's "rules changed" signal -
      // it re-runs the preview panel's check for whoever is on screen (a stale verdict misreports the edit).
      setRulesVersion((v) => v + 1);
    } catch (e) {
      toast({ variant: "destructive", title: "Could not load access", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }, [target, showUsers, showRoles, toast]);

  React.useEffect(() => {
    if (target) void reload();
    setFocusVerb(undefined);
    setAddUsers([]);
    setAddExpires("");
    setShowHistory(false);
  }, [target, reload]);

  // Provenance for the rules on screen: the audit trail already records every access-rule write, so "who
  // added this and when" is a read, not new bookkeeping. Scoped to this collection by the free-text `q`
  // (the audit meta carries the collection name), newest first.
  React.useEffect(() => {
    if (!target?.collection) return;
    let live = true;
    api<{ results: RuleEvent[] }>(`/activity?entity=access-rules&q=${encodeURIComponent(target.collection)}&max_page_size=50`)
      .then((p) => live && setEvents(p.results))
      .catch(() => live && setEvents([])); // no audit capability -> no provenance, never an error
    return () => {
      live = false;
    };
  }, [target?.collection, rulesVersion]);
  // Rule id -> the event that created it, for the "added by …" line under each rule.
  const originOf = React.useCallback(
    (rulePath: string): RuleEvent | undefined => {
      const id = rulePath.split("/").pop();
      return events.find((e) => e.meta?.rule_id === id && (e.action === "access-rule.create" || e.action === "access-rule.approve" || e.action === "access-rule.request"));
    },
    [events],
  );
  const actorOf = (e: RuleEvent) => e.actor_name || e.actor_email || "someone";
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
  // A date-only picker means "expires at the end of that day", which is what "access until Friday" means to
  // a human - the server takes any ISO instant.
  const expiryBody = (): Record<string, unknown> => (addExpires ? { expire_time: new Date(`${addExpires}T23:59:59`).toISOString() } : {});

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
  // How a person is named everywhere in this modal - the picker, the chips, the rule rows and the plain-English
  // grant sentence. Name AND email: two people share a first name, nobody shares an address.
  const labelOfUser = (u: User) => {
    const name = u.employee ? names[u.employee] : undefined;
    return name ? `${name} · ${u.email}` : u.email;
  };
  const emailOf = (subject: string) => {
    const u = users.find((x) => x.path === subject);
    return u ? labelOfUser(u) : subject;
  };

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
  }, [userShown, userFilter, users, names]);
  const rolePaged = usePaged(shownRoles, 8);
  const userPaged = usePaged(shownUserRules, 8);

  // "2 roles + 1 person can approve" - the state of this target in one line, before anyone scrolls through
  // eight dropdowns. Counted from the rules that ALLOW on this target at ANY scope tier (a dept-scoped grant
  // is still someone who can), plus the `everyone` rule called out by name since it means the whole company.
  const holders = React.useMemo(() => {
    const onTarget = (r: AccessRule) =>
      r.effect === "allow" &&
      r.status !== "pending" &&
      r.collection === collection &&
      (r.field ?? undefined) === (field ?? undefined) &&
      (verbMode ? r.verb === activeVerb || r.verb === ALL_VERBS : !r.verb) &&
      (createMode ? r.scope === "create" : r.scope !== "create");
    const matched = rules.filter(onTarget);
    return {
      roles: new Set(matched.filter((r) => r.subject_kind === "role" && r.subject !== EVERYONE_ROLE).map((r) => r.subject)).size,
      people: new Set(matched.filter((r) => r.subject_kind === "user").map((r) => r.subject)).size,
      everyone: matched.some((r) => r.subject_kind === "role" && r.subject === EVERYONE_ROLE),
      pending: rules.filter((r) => r.collection === collection && r.status && r.status !== "active").length,
    };
  }, [rules, collection, field, verbMode, activeVerb, createMode]);
  const canDoWhat = createMode ? "create" : verbMode ? (activeVerb === ALL_VERBS ? "use these methods" : `use ${verbInfo(collection ?? "", activeVerb!).label.toLowerCase()}`) : "see this";

  // Impact line for a destructive change (deny / rule removal): ask the engine how many people can do the
  // target thing RIGHT NOW, so the confirm dialog states what is being taken away instead of a bare "sure?".
  // Preview-capability holders only; everyone else keeps the plain confirm (fail quiet, never block).
  const canPreview = usePermission("access-rules.preview");
  // Deciding a pending change is its own verb, and deliberately not the one that PROPOSES it (maker-checker):
  // an author holding `access-rules.write` alone must see the "awaiting approval" badge without an approve or
  // reject they cannot use.
  const canDecideRule = usePermission("access-rules.approve");
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

  // Re-author an existing rule from its serialized form - the inverse of a delete, and the building block of
  // every Undo below. Field-for-field, so an undone rule is identical to the one that was there.
  const recreate = (r: AccessRule) =>
    create("access-rules", {
      subject_kind: r.subject_kind,
      subject: r.subject,
      collection: r.collection,
      scope: r.scope,
      ...(r.scope_ref ? { scope_ref: r.scope_ref } : {}),
      ...(r.field ? { field: r.field } : {}),
      ...(r.verb ? { verb: r.verb } : r.level ? { level: r.level } : {}),
      ...(r.effect === "deny" ? { effect: "deny" } : {}),
      ...(r.expire_time ? { expire_time: r.expire_time } : {}),
    });

  // Every rule change is one click from being taken back. Permissions are exactly the kind of edit where the
  // wrong pick is noticed one second later, and an 8s Undo beats reconstructing the previous rule by hand.
  function undoable(title: string, undo: () => Promise<unknown>) {
    toast({
      title,
      duration: 8000,
      action: {
        label: "Undo",
        onClick: () => {
          setBusy(true);
          undo()
            .then(() => toast({ title: "Change undone" }))
            .catch((e) => toast({ variant: "destructive", title: "Could not undo", description: String((e as Error).message) }))
            .finally(() => void reload());
        },
      },
    });
  }

  async function setRoleLevel(name: string, value: string) {
    if (value === "deny") {
      const ok = await confirm({ title: `Deny ${roleLabel(name)} here?`, description: await impactLine(), destructive: true, confirmLabel: "Deny" });
      if (!ok) return;
    }
    // Authoring an allow where a deny already covers the target writes a DEAD rule: the dropdown will read
    // "write" and the person still gets 403. Say so before it lands, not after someone debugs it.
    if (value !== "none" && value !== "deny") {
      const blocker = denyBlocking({ subject_kind: "role", subject: name, collection: collection ?? "", scope: scopeSel, field, verb: activeVerb }, rules);
      if (blocker && !(await confirm({ title: "A deny is already in place", description: `${ruleSentence(blocker, roleLabel(blocker.subject))}. A deny always wins, so this allow will have NO effect until that rule is removed. Add it anyway?`, confirmLabel: "Add anyway" }))) return;
    }
    setBusy(true);
    try {
      const before = roleAll(name).filter((x) => !x.verb);
      for (const r of before) await remove(r.path, r.etag); // edit = delete + create
      // An expiring DENY would quietly re-open access on a date nobody is watching, so an expiry only ever
      // rides on a grant.
      if (value !== "none") await create("access-rules", { subject_kind: "role", subject: name, collection, ...scopeBody(), ...levelBody(value), ...(value === "deny" ? {} : expiryBody()) });
      undoable(`Updated ${roleLabel(name)}`, async () => {
        for (const r of (await fetchAllAccessRules()).filter((x) => x.subject_kind === "role" && x.subject === name && matchesTarget(x) && !x.verb)) await remove(r.path, r.etag);
        for (const r of before) await recreate(r);
      });
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
      const before = roleAll(name).filter((x) => x.verb === v);
      for (const r of before) await remove(r.path, r.etag);
      if (value !== "none") await create("access-rules", { subject_kind: "role", subject: name, collection, ...scopeBody(), ...verbBody(v, value as "allow" | "deny"), ...(value === "deny" ? {} : expiryBody()) });
      undoable(`Updated ${roleLabel(name)} · ${v}`, async () => {
        for (const r of (await fetchAllAccessRules()).filter((x) => x.subject_kind === "role" && x.subject === name && matchesTarget(x) && x.verb === v)) await remove(r.path, r.etag);
        for (const r of before) await recreate(r);
      });
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

  // One rule per picked person, in one go. Rules that already exist come back as a 409 from the server; that
  // person is reported as skipped instead of failing the whole batch, so a bulk grant is safely repeatable.
  async function addUserRule() {
    const subjects = addUsers;
    if (!subjects.length) return;
    if (addAccess !== "deny") {
      const blocker = subjects.map((s) => denyBlocking({ subject_kind: "user", subject: s, collection: collection ?? "", scope: scopeSel, field, verb: activeVerb }, rules)).find(Boolean);
      if (blocker && !(await confirm({ title: "A deny is already in place", description: `${ruleSentence(blocker, "This person")}. A deny always wins, so the new rule will have NO effect until it is removed. Add it anyway?`, confirmLabel: "Add anyway" }))) return;
    }
    setBusy(true);
    try {
      const body = verbMode ? verbBody(activeVerb!, addAccess === "deny" ? "deny" : "allow") : levelBody(addAccess);
      const added: string[] = [];
      let skipped = 0;
      for (const subject of subjects) {
        try {
          const row = await create<AccessRule>("access-rules", { subject_kind: "user", subject, collection, ...scopeBody(), ...body, ...expiryBody() });
          added.push(row.path);
        } catch (e) {
          if (String((e as Error).message).toLowerCase().includes("already exists")) skipped++;
          else throw e;
        }
      }
      setAddUsers([]);
      undoable(
        `${added.length} ${added.length === 1 ? "person" : "people"} updated${skipped ? ` · ${skipped} already had it` : ""}`,
        async () => {
          for (const path of added) await remove(path);
        },
      );
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
      undoable("Access rule removed", () => recreate(r));
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not remove", description: String((e as Error).message) });
      setBusy(false);
    }
  }

  // Four-eyes decision on a pending change (the verbs are fail-closed, so the buttons only appear for people
  // the server would actually let decide - and it re-checks that the requester is not the approver).
  async function decide(r: AccessRule, decision: "approve" | "reject") {
    setBusy(true);
    try {
      await invoke("access-rules", decision, undefined, { rule: r.path });
      toast({ title: decision === "approve" ? "Change approved" : "Change rejected" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: `Could not ${decision}`, description: String((e as Error).message) });
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
      {/* The modal grew: holders line, deny banner, presets, the preview panel, then two paginated lists. On a
          phone that is taller than the viewport, and the dialog primitive does not scroll on its own - so cap
          it against the DYNAMIC viewport height (dvh, which excludes the mobile browser chrome) and scroll
          inside. */}
      <DialogContent className="max-w-2xl lg:max-w-3xl">
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

        {/* The current state in one line, plus the trail behind it. Without this the modal opens on eight
            dropdowns and answers "who can do this?" only after scanning all of them. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            {holders.everyone ? (
              <span className="text-indigo-700 dark:text-indigo-300">Everyone can {canDoWhat}</span>
            ) : holders.roles + holders.people === 0 ? (
              <span className="text-muted-foreground">Nobody but full admins can {canDoWhat}</span>
            ) : (
              <span>
                {[holders.roles && `${holders.roles} ${holders.roles === 1 ? "role" : "roles"}`, holders.people && `${holders.people} ${holders.people === 1 ? "person" : "people"}`].filter(Boolean).join(" + ")} can {canDoWhat}
              </span>
            )}
          </span>
          {holders.pending > 0 && (
            <Badge variant="secondary" className="gap-1 text-amber-700 dark:text-amber-400">
              <Clock className="h-3 w-3" /> {holders.pending} awaiting approval
            </Badge>
          )}
          {events.length > 0 && (
            <button type="button" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowHistory((s) => !s)}>
              <History className="h-3.5 w-3.5" /> {showHistory ? "hide" : "recent changes"}
            </button>
          )}
        </div>
        {showHistory && (
          <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
            {events.slice(0, 12).map((e) => (
              <li key={e.path} className="truncate">
                <span className="font-medium text-foreground">{actorOf(e)}</span> {e.action.replace("access-rule.", "")}d{e.meta?.sentence ? ` ${e.meta.sentence}` : ""} · {timeAgo(e.create_time)}
              </li>
            ))}
          </ul>
        )}

        {/* The recurring confusion of the whole model: creating is NOT write-on-existing-objects. Say it in
            the one place someone is about to author a create rule. */}
        {createMode && (
          <p className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 p-2.5 text-xs text-muted-foreground">
            <Info className="mt-px h-3.5 w-3.5 shrink-0 text-primary" />
            <span>
              This gate is only about making NEW {plural}. It does not let anyone see or edit existing ones - that is the write level on the {meta.label.toLowerCase()} icon itself. Most self-service setups want both (create + own records).
            </span>
          </p>
        )}

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

        {/* Deny rules on this exact target, spelled out. The red key icon says a deny exists somewhere; this
            says WHICH, so the allow someone is about to add is not authored dead. */}
        {(() => {
          const denies = rules.filter((r) => r.effect === "deny" && matchesTarget(r) && (verbMode ? r.verb === activeVerb : !r.verb));
          if (!denies.length) return null;
          return (
            <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-destructive" />
              <span>
                A deny is in force here ({denies.map((d) => (d.subject_kind === "role" ? roleLabel(d.subject) : emailOf(d.subject))).join(", ")}). A deny always wins, so an allow added below stays inert for them until the deny is removed.
              </span>
            </p>
          );
        })()}

        {/* Ground truth: what the engine actually answers for a chosen person on this target. */}
        {target && <PreviewPanel target={{ ...target, verb: undefined }} activeVerb={activeVerb} createMode={createMode} rulesVersion={rulesVersion} />}

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
                <Button
                  key={v}
                  variant="outline"
                  size="sm"
                  className="h-7"
                  title={[info.description ?? v, info.caution].filter(Boolean).join("\n\n")}
                  onClick={() => setFocusVerb(v)}
                >
                  {info.label}
                  {/* A verb that grants more than its name says gets a visible mark, not just a tooltip - the
                      reader has to be able to spot it while scanning the row, before clicking. */}
                  {info.caution && <span className="ml-1 text-amber-600 dark:text-amber-500">!</span>}
                </Button>
              );
            })}
          </div>
        )}
        {/* Spelled out in full once a cautioned verb is the one in focus, where the grant is actually made. */}
        {verbMode && activeVerb && activeVerb !== ALL_VERBS && verbInfo(collection ?? "", activeVerb).caution && (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
            {verbInfo(collection ?? "", activeVerb).caution}
          </p>
        )}

        <Tabs defaultValue={defaultTab}>
          {/* The counts are on the tabs so the reader knows which one holds the answer before opening it -
              "Roles 0 · Users 3" says where this target's access actually comes from. */}
          <TabsList>
            {showUsers && (
              <TabsTrigger value="users">
                Users{userShown.length > 0 ? ` ${userShown.length}` : ""}
              </TabsTrigger>
            )}
            {showRoles && (
              <TabsTrigger value="roles">
                Roles{holders.roles > 0 ? ` ${holders.roles}` : ""}
              </TabsTrigger>
            )}
          </TabsList>

          {showUsers && (
            <TabsContent value="users" className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Per-user access on {scopeNote}. {verbMode ? "A custom method is denied unless explicitly allowed; a deny always wins." : "A deny always wins."}
                {!verbMode && !createMode && " Levels nest: read ⊂ write ⊂ full (full = delete + purge)."}
              </p>
              {userShown.length > 8 && <Input className="h-8" placeholder="Filter by name or email…" value={userFilter} onChange={(e) => setUserFilter(e.target.value)} />}
              <div className="space-y-2">
                {userShown.length === 0 && <p className="text-sm text-muted-foreground">No per-user rules here.</p>}
                {userShown.length > 0 && shownUserRules.length === 0 && <p className="text-sm text-muted-foreground">No rule matches "{userFilter}".</p>}
                {userPaged.pageItems.map((r) => (
                  // Same stacking as the role rows: person on top, the badges and controls beneath, one row
                  // from `sm` up. An email plus an expiry badge plus an approve/reject pair does not fit a
                  // phone side by side.
                  <div key={r.path} className={cn("flex flex-col gap-2 rounded-md border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between", r.status && r.status !== "active" && "border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30")}>
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
                      {/* Who put this rule here, and when - a mystery rule nobody will dare remove becomes an
                          accountable one. Falls back to the rule's own create time when the trail is not readable. */}
                      {(() => {
                        const origin = originOf(r.path);
                        const when = origin?.create_time ?? r.create_time;
                        return when ? (
                          <span className="truncate text-[11px] text-muted-foreground">
                            {origin ? `added by ${actorOf(origin)} · ` : "added "}
                            {timeAgo(when)}
                          </span>
                        ) : null;
                      })()}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {expiryLabel(r.expire_time) && (
                        <Badge variant="muted" className="gap-1">
                          <Clock className="h-3 w-3" /> {expiryLabel(r.expire_time)}
                        </Badge>
                      )}
                      {r.status && r.status !== "active" && (
                        <>
                          <Badge variant="secondary" className="gap-1 text-amber-700 dark:text-amber-400">
                            <Clock className="h-3 w-3" /> {r.status === "pending" ? "awaiting approval" : "removal awaiting approval"}
                          </Badge>
                          {canDecideRule && (
                            <>
                              <Button variant="ghost" size="icon" title="Approve this change" disabled={busy} onClick={() => decide(r, "approve")}>
                                <Check className="h-4 w-4 text-emerald-600" />
                              </Button>
                              <Button variant="ghost" size="icon" title="Reject this change" disabled={busy} onClick={() => decide(r, "reject")}>
                                <X className="h-4 w-4 text-destructive" />
                              </Button>
                            </>
                          )}
                        </>
                      )}
                      {/* Same tone as the dropdowns, so an existing per-user rule reads as the same thing the
                          dropdown would say (a granted level is coloured; a deny stays the destructive badge). */}
                      <Badge variant={r.effect === "deny" ? "destructive" : "secondary"} className={r.effect === "deny" ? undefined : accessTone(r.verb ? "allow" : r.level ?? "allow", createMode).text}>
                        {r.effect === "deny" ? "deny" : r.verb ? verbInfo(collection ?? "", r.verb).label : createMode ? "can create" : levelLabel(r.level ?? "allow")}
                      </Badge>
                      <Button variant="ghost" size="icon" aria-label="Remove this access rule" disabled={busy} onClick={() => removeRule(r)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <Pager page={userPaged.page} totalPages={userPaged.totalPages} total={userPaged.total} onPage={userPaged.setPage} />
              <div className="space-y-2 border-t pt-3">
                {/* Bulk grant: picking a person parks them as a chip, so the same access goes to several
                    people in ONE add instead of one open-pick-add cycle each. */}
                {addUsers.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {addUsers.map((u) => (
                      <button key={u} type="button" onClick={() => setAddUsers((xs) => xs.filter((x) => x !== u))} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs hover:bg-muted" title="Remove from this grant">
                        {emailOf(u)} <X className="h-3 w-3" />
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-48 flex-1">
                    <label className="mb-1 block text-xs font-medium">{addUsers.length ? "Add another person" : "User"}</label>
                    <Combobox
                      value=""
                      onValueChange={(v) => v && setAddUsers((xs) => (xs.includes(v) ? xs : [...xs, v]))}
                      options={users.filter((u) => !addUsers.includes(u.path)).map((u) => ({ value: u.path, label: labelOfUser(u) }))}
                      placeholder="Search people…"
                    />
                  </div>
                  <div className="w-40">
                    <label className="mb-1 block text-xs font-medium">{verbMode ? "Effect" : createMode ? "Create" : "Access"}</label>
                    <Select value={addAccess} onValueChange={setAddAccess}>
                      <SelectTrigger className={ACCESS_TRIGGER}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(verbMode ? (activeVerb === ALL_VERBS ? ["allow"] : ["allow", "deny"]) : levelChoices).map((l) => (
                          <SelectItem key={l} value={l}>
                            <AccessOption value={l} label={verbMode ? l : levelLabel(l)} />
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* Temporary access: a contractor's grant that removes itself beats one nobody remembers
                      to revoke. Empty = permanent. */}
                  {addAccess !== "deny" && (
                    <div className="w-36">
                      <label className="mb-1 block text-xs font-medium" title="Leave empty for permanent access.">Expires (optional)</label>
                      <Input type="date" className="h-9" value={addExpires} min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} onChange={(e) => setAddExpires(e.target.value)} />
                    </div>
                  )}
                  <Button disabled={busy || !addUsers.length} onClick={addUserRule}>
                    <Plus className="h-4 w-4" /> Add{addUsers.length > 1 ? ` ${addUsers.length}` : ""}
                  </Button>
                </div>
                {/* The rule reads before it lands: the exact sentence the engine will enforce. */}
                {addUsers.length > 0 && (
                  <p className="rounded-md bg-muted/40 px-2 py-1.5 text-xs">
                    <span className="font-medium">Grant:</span>{" "}
                    {ruleSentence(
                      { path: "", subject_kind: "user", subject: addUsers[0]!, collection: collection ?? "", scope: createMode ? "create" : scopeSel, field, ...(verbMode ? { verb: activeVerb } : { level: addAccess }), effect: addAccess === "deny" ? "deny" : "allow" },
                      addUsers.length > 1 ? `${addUsers.length} people` : emailOf(addUsers[0]!),
                    )}
                    {addExpires && addAccess !== "deny" ? `, until ${addExpires}` : ""}
                  </p>
                )}
              </div>
            </TabsContent>
          )}

          {showRoles && (
            <TabsContent value="roles" className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Access per role on {scopeNote} (one rule per role). {verbMode && "Allowed only with an explicit allow; a deny wins."}
                {!verbMode && !createMode && " Levels nest: read ⊂ write ⊂ full (full = delete + purge)."}
              </p>
              {/* Temporary access for a ROLE, not just a person: an audit window, a cover period, a project
                  team that should stop having this in March. The write path already carried an expiry (the
                  per-user add form has one); the roles tab simply never offered the control, so a role grant
                  was always permanent and relied on somebody remembering to take it away. */}
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs">
                <span className="font-medium text-muted-foreground">Expires:</span>
                <Input
                  type="date"
                  className="h-8 w-40"
                  value={addExpires}
                  min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                  onChange={(e) => setAddExpires(e.target.value)}
                />
                <span className="text-muted-foreground">
                  {addExpires ? `Access set below removes itself on ${addExpires}.` : "Empty = permanent. Set a date and the next level you pick expires on it."}
                </span>
                {addExpires && (
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setAddExpires("")}>Clear</Button>
                )}
              </div>
              {sortedRoles.length > 8 && <Input className="h-8" placeholder="Filter roles…" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} />}
              <div className="space-y-2">
                {sortedRoles.length > 0 && shownRoles.length === 0 && <p className="text-sm text-muted-foreground">No role matches "{roleFilter}".</p>}
                {rolePaged.pageItems.map((role) => {
                  const isEveryone = role.name === EVERYONE_ROLE;
                  return (
                  <div
                    key={role.name}
                    // A 160px access dropdown plus the row's padding leaves the role name about 150px on a
                    // phone, and the name carries badges ("awaiting approval") that cannot wrap out of the
                    // way. Stacked below `sm` - name over control, control full width - and the same single
                    // row from `sm` up.
                    className={cn(
                      "flex flex-col gap-2 rounded-md border px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between",
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
                      // Lifecycle of THIS role's rules on this target: a pending change (four-eyes) or a
                      // temporary grant is invisible in the level dropdown, so it rides beside the name.
                      const mine = roleAll(role.name).filter((x) => (verbMode ? x.verb === activeVerb : !x.verb));
                      const pendingRule = mine.find((x) => x.status && x.status !== "active");
                      const expiring = mine.map((x) => expiryLabel(x.expire_time)).find(Boolean);
                      const origin = mine[0] ? originOf(mine[0].path) : undefined;
                      const notes = (
                        <>
                          {alsoNote}
                          {origin && <span className="text-[11px] text-muted-foreground">added by {actorOf(origin)} · {timeAgo(origin.create_time)}</span>}
                          <span className="flex flex-wrap items-center gap-1">
                            {expiring && (
                              <Badge variant="muted" className="gap-1">
                                <Clock className="h-3 w-3" /> {expiring}
                              </Badge>
                            )}
                            {pendingRule && (
                              <>
                                <Badge variant="secondary" className="gap-1 text-amber-700 dark:text-amber-400">
                                  <Clock className="h-3 w-3" /> {pendingRule.status === "pending" ? "awaiting approval" : "removal awaiting approval"}
                                </Badge>
                                {canDecideRule && (
                                  <>
                                    <button type="button" disabled={busy} onClick={() => decide(pendingRule, "approve")} className="text-[11px] font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400">approve</button>
                                    <button type="button" disabled={busy} onClick={() => decide(pendingRule, "reject")} className="text-[11px] font-medium text-destructive underline-offset-2 hover:underline">reject</button>
                                  </>
                                )}
                              </>
                            )}
                          </span>
                        </>
                      );
                      return isEveryone ? (
                        <span className="flex flex-col">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                            <Globe className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                            <span className="font-medium text-indigo-700 dark:text-indigo-300">Everyone</span>
                            <span className="text-xs text-muted-foreground">all signed-in users</span>
                          </span>
                          {notes}
                        </span>
                      ) : (
                        <span className="flex flex-col">
                          <span>{roleLabel(role.name)}</span>
                          {notes}
                        </span>
                      );
                    })()}
                    {verbMode ? (
                      <Select value={roleVerbCurrent(role.name, activeVerb!)} onValueChange={(v) => setRoleVerb(role.name, activeVerb!, v)} disabled={busy}>
                        <SelectTrigger className={cn("w-full shrink-0 sm:w-40", ACCESS_TRIGGER)}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(activeVerb === ALL_VERBS ? (["none", "allow"] as const) : VERB_EFFECTS).map((l) => (
                            <SelectItem key={l} value={l}>
                              <AccessOption value={l} label={l} />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select value={roleLevelCurrent(role.name)} onValueChange={(v) => setRoleLevel(role.name, v)} disabled={busy}>
                        <SelectTrigger className={cn("w-full shrink-0 sm:w-40", ACCESS_TRIGGER)}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">
                            <AccessOption value="none" label={createMode ? "cannot create" : "none"} />
                          </SelectItem>
                          {levelChoices.map((l) => (
                            <SelectItem key={l} value={l}>
                              <AccessOption value={l} label={levelLabel(l)} />
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
