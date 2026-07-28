import * as React from "react";
import { KeyRound, Trash2, Plus, ShieldCheck, ArrowLeft, Zap, Globe, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";
import { list, create, remove } from "@/api";
import { fetchAllAccessRules } from "./permMatrix";
import { usePaged, Pager } from "@/components/common/Pager";
import { roleLabel, EVERYONE_ROLE } from "@/lib/roles";
import type { User } from "@/types";
import type { AccessTargetRef } from "./AccessModeProvider";
import { ruleScopeFor, ruleMatchesTarget } from "./accessRuleScope";
import { customMethodsFor } from "./customMethods";
import { scopesForCollection, fetchScopeCapabilities } from "./permMatrix";

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
const verbLabel = (v: string) => (v === ALL_VERBS ? "all methods" : v);

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
      if (showUsers) tasks.push(list<User>("users").then((r) => setUsers(r.results)));
      if (showRoles) tasks.push(list<Role>("roles").then((r) => setRoles(r.results)));
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
  const rolePaged = usePaged(sortedRoles, 8);
  const userPaged = usePaged(userShown, 8);

  async function setRoleLevel(name: string, value: string) {
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
    const ok = await confirm({ title: "Remove this access rule?", destructive: true, confirmLabel: "Remove" });
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

  // Readable collection nouns (kebab -> words; naive singularize is fine for our collections).
  const plural = (collection ?? "").replace(/-/g, " ");
  const singular = plural.endsWith("s") ? plural.slice(0, -1) : plural;
  // The object the rule lands on, in words. `target.label` is a real object name ONLY for a plain object
  // target; for a field/verb target it's the field/verb name, so fall back to a generic "this <singular>".
  const objectName = hasObject && !hasField && !verbMode ? (target?.label ?? `this ${singular}`) : `this ${singular}`;
  const whereNote =
    scopeSel === "exact" ? objectName
    : scopeSel === "subtree" ? `${objectName} & below`
    : scopeSel === "self" ? `their own ${plural}`
    : scopeSel === "dept" ? `their department's ${plural}`
    : `all ${plural}`;
  const scopeNote = createMode
    ? `creating a new ${singular}`
    : verbMode
    ? `${activeVerb === ALL_VERBS ? "all methods" : `the "${activeVerb}" method`} on ${whereNote}`
    : hasField
    ? `the "${target?.label ?? field}" field of ${whereNote}`
    : whereNote;

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-600 dark:text-amber-400" /> Manage access
          </DialogTitle>
          <DialogDescription>
            {createMode ? (
              <>
                Who can create a new <code className="rounded bg-muted px-1">{singular}</code>
              </>
            ) : verbMode ? (
              <>
                {activeVerb === ALL_VERBS ? "All custom methods" : <>Custom method <code className="rounded bg-muted px-1">{activeVerb}</code></>} on {whereNote}
              </>
            ) : hasField ? (
              <>
                Field <code className="rounded bg-muted px-1">{target?.label ?? field}</code> of {whereNote}
              </>
            ) : (
              <>{whereNote}</>
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

        {/* Scope chips: how broadly the rule applies - this object, the subject's own / department rows, or the
            whole collection. Options + narrowest-first default come from the central scopesForCollection, so
            every access icon offers the same (relevant) choices. Hidden when there's only one (e.g. a plain
            collection that isn't owner-scoped is collection-wide only). */}
        {scopeOpts.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/30 p-2">
            <span className="mr-1 text-xs font-medium text-muted-foreground">Scope:</span>
            {scopeOpts.map((s) => (
              <Button key={s.value} variant={scopeSel === s.value ? "default" : "outline"} size="sm" className="h-7" onClick={() => setScopeSel(s.value)}>
                {s.value === "exact" ? `This ${singular}` : s.value === "subtree" ? `This ${singular} & below` : s.label}
              </Button>
            ))}
          </div>
        )}

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
            {collectionVerbs.map((v) => (
              <Button key={v} variant="outline" size="sm" className="h-7" onClick={() => setFocusVerb(v)}>
                {v}
              </Button>
            ))}
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
              <div className="space-y-2">
                {userShown.length === 0 && <p className="text-sm text-muted-foreground">No per-user rules here.</p>}
                {userPaged.pageItems.map((r) => (
                  <div key={r.path} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <span className="truncate">{emailOf(r.subject)}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant={r.effect === "deny" ? "destructive" : "secondary"}>{r.effect === "deny" ? "deny" : r.verb ? verbLabel(r.verb) : createMode ? "can create" : levelLabel(r.level ?? "allow")}</Badge>
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
                  <Select value={addUser} onValueChange={setAddUser}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a user…" />
                    </SelectTrigger>
                    <SelectContent>
                      {users.map((u) => (
                        <SelectItem key={u.path} value={u.path}>
                          {u.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
              <div className="space-y-2">
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
                    {isEveryone ? (
                      <span className="flex items-center gap-2">
                        <Globe className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                        <span className="font-medium text-indigo-700 dark:text-indigo-300">Everyone</span>
                        <span className="text-xs text-muted-foreground">all signed-in users</span>
                      </span>
                    ) : (
                      <span>{roleLabel(role.name)}</span>
                    )}
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
