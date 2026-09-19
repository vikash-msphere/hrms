import * as React from "react";
import { createPortal } from "react-dom";
import { Download, Upload, GitCompareArrows, KeyRound, Sparkles } from "lucide-react";
import { listAll, create, remove, get, invoke } from "@/api";
import { ruleSentence, expiryLabel } from "@/components/access/ruleLogic";
import { Checkbox } from "@/components/ui/checkbox";
import { usePermission } from "@/lib/perm";
import { roleLabel, registerRoleLabels, EVERYONE_ROLE } from "@/lib/roles";
import { CopyEmail } from "@/components/common/CopyEmail";
import { ruleScopeFor, ruleMatchesTarget } from "@/components/access/accessRuleScope";
import { type AccessRule, CELL, labelOf, fetchAllAccessRules, collectionsForRules, COLLECTION_GROUPS, groupOf, accessTone } from "@/components/access/permMatrix";
import { CellOption } from "@/components/access/CellOption";
import { cloneAccessRules, restoreAccessRules, ruleBody } from "@/components/access/cloneRules";
import { ROLE_TEMPLATES, templateRuleBody, templateSize } from "@/components/access/roleTemplates";
import { useAccessMode } from "@/components/access/AccessModeProvider";
import { AccessAction } from "@/components/access/AccessAction";
import { useConfirm } from "@/components/common/confirm";
import { confirmDecision } from "@/lib/confirmDecision";
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
import { getSetting, saveSetting } from "@/lib/settingsStore";
import { todayStr } from "@/lib/orgDay";
import { saveBytes } from "@/lib/download";

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
  // The role a starter pack is being applied to, once one is chosen. A fresh role is deny-all, so the first
  // thing an admin needs after creating one is a defensible starting point rather than an empty grid.
  const [template, setTemplate] = React.useState<{ kind: Kind; subject: string; key: string } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [rules, setRules] = React.useState<AccessRule[]>([]);
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [users, setUsers] = React.useState<{ path: string; email: string }[]>([]);
  // Starts BUSY: the panel loads on mount, so the first paint is a load in progress, not an idle panel with
  // nothing in it. Everything that reads `busy` - the disabled cells, the matrix's own placeholder - would
  // otherwise spend that first frame claiming the org has no roles and offering editors over it.
  const [busy, setBusy] = React.useState(true);
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

  // Periodic recertification of standing privilege (settings key `access-review`). Sits beside four-eyes
  // because they are the two halves of governing a rule's LIFE: one guards how it is made, the other asks
  // whether it is still wanted. `expires_at` already covers access somebody knew was temporary; this is the
  // grant made for one project that nobody's job it is to remove.
  const [review, setReview] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    getSetting<{ enabled?: boolean }>("access-review")
      .then((s) => setReview(s.value?.enabled === true))
      .catch(() => setReview(null));
  }, []);

  async function setReviewEnabled(enabled: boolean) {
    // Only the ON direction asks, and it asks nothing alarming: this schedules a reminder, it never removes
    // access. Turning it off stops a notification, which needs no ceremony.
    if (enabled && !(await confirm({
      title: "Ask for a quarterly access review?",
      description: "Every 90 days the access admins get one notification listing the permanent rules that grant write access or a custom method, to confirm or remove. It only reminds - no access is ever changed for you.",
      confirmLabel: "Turn on",
    }))) return;
    try {
      // `last_run` is deliberately not sent: the cron owns it, and resetting it here would make a toggle
      // re-trigger a review that already went out.
      await saveSetting("access-review", { value: { enabled } });
      setReview(enabled);
      toast({ title: enabled ? "Access reviews scheduled" : "Access reviews turned off", variant: "success" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
    }
  }

  async function setFourEyesEnabled(enabled: boolean) {
    // BOTH directions ask. Turning this off is the consequential one: it removes the second pair of eyes from
    // every subsequent rule write (accessRules.ts `approvalRequired` is consulted per write, so the next grant
    // goes live immediately), and it is one unticked checkbox away for anyone holding a single access-admin
    // session. The on-direction adds a control; the off-direction takes it away, so it gets the destructive
    // prompt rather than no prompt at all.
    const ok = enabled
      ? await confirm({ title: "Require a second approver for permission changes?", description: "From now on every access-rule change waits for a DIFFERENT access admin to approve it. A new grant does nothing until approved; a removal keeps working until approved. If you are the only access admin, nobody can approve your changes - turn this back off to unblock.", confirmLabel: "Turn on" })
      : await confirm({
          title: "Stop requiring a second approver?",
          description: "Every access-rule change will take effect immediately, with no second admin reviewing it. Changes already waiting stay in the queue until someone decides them.",
          destructive: true,
          confirmLabel: "Turn off",
        });
    if (!ok) return;
    try {
      await saveSetting("access-approval", { value: { enabled } });
      setFourEyes(enabled);
      toast({ title: enabled ? "Permission changes now need a second approver" : "Permission changes apply immediately again", variant: "success" });
    } catch (e) {
      toast({ variant: "destructive", title: "Couldn't save", description: String((e as Error).message) });
    }
  }

  async function decide(r: AccessRule, decision: "approve" | "reject") {
    // Approving is what makes the grant live, and it cannot be taken back from this button - the same beat of
    // friction every other decision verb in the app gets (lib/confirmDecision), with the rule as the subject
    // so the dialog can't be mistaken for the row above or below.
    const subject = ruleSentence(r, r.subject_kind === "role" ? roleLabel(r.subject) : (users.find((u) => u.path === r.subject)?.email ?? "This person"));
    if (!(await confirmDecision(confirm, decision, subject))) return;
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
      // Every role AND every user, not the first page. For roles: a rule whose subject is a role past the cap
      // would otherwise render as a bare machine name here and be missing from the copy-permissions picker
      // entirely. For users it is worse - each row IS the editor for that person's per-user rules, so a login
      // outside the window has no row, their existing rules are invisible, and the matrix presents itself as
      // the whole access model while missing people from it.
      const [ro, us] = await Promise.all([listAll<Role>("roles"), listAll<User>("users")]);
      registerRoleLabels(ro);
      setRoles(ro);
      setUsers(us.map((u) => ({ path: u.path, email: u.email })));
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


  // Set one cell of the matrix. An edit is delete-then-create (the API keys one rule per subject/collection/
  // scope), so the two failure modes this guards are both consequences of that, and both used to be live:
  //
  //   - the deletes are committed even when the create that replaces them fails, so a failed edit REMOVED the
  //     subject's access while reporting only "Could not update". The rules are put back (see
  //     restoreAccessRules, which is also correct under four-eyes), and if any of them cannot be, the toast
  //     says so instead of leaving the row quietly wrong.
  //   - the grid was re-read only on the success path, so after a failure it went on rendering the level the
  //     subject used to hold. On a permissions page that is the worst available outcome: a grant that is gone
  //     and a grid that says it is there are indistinguishable from a grid that is right. The reload is now
  //     unconditional, and it owns clearing `busy` (see reload's own finally).
  async function setCell(kind: Kind, subject: string, collection: string, value: string, label: string) {
    setBusy(true);
    const removed: AccessRule[] = [];
    try {
      for (const r of cellRules(kind, subject, collection)) {
        await remove(r.path, r.etag);
        removed.push(r);
      }
      if (value !== "none") {
        const body = value === "deny" ? { effect: "deny" } : { level: value };
        await create("access-rules", { subject_kind: kind, subject, collection, ...ruleScopeFor({ collection }), ...body });
      }
      toast({ title: `Updated ${label} · ${labelOf(collection)}` });
    } catch (e) {
      const outstanding = removed.length - (await restoreAccessRules(removed));
      toast({
        variant: "destructive",
        title: "Could not update",
        description: outstanding
          ? `${String((e as Error).message)} - and ${outstanding} rule${outstanding === 1 ? "" : "s"} that had to be removed first could not be put back. Check ${label} · ${labelOf(collection)} before relying on it.`
          : String((e as Error).message),
      });
    }
    await reload();
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

  // Users matrix: one row per user, one column per collection. The rows come from a cursor walk (`listAll`
  // in reload) rather than a page, because DataTable paginates the rows it is HANDED - it cannot page a
  // collection that was never fetched, and a person with no row here has no editable per-user access at all.
  const userMatrixCols: Column<{ path: string; email: string }>[] = [
    { id: "user", header: "User", filter: "text", accessor: (u) => u.email, cell: (u) => <CopyEmail email={u.email} className="font-medium" /> },
    ...collections.map((c) => ({ id: c, header: labelOf(c), sortable: false, filter: "none", accessor: (u: { path: string; email: string }) => valueOf("user", u.path, c), cell: (u: { path: string; email: string }) => levelCell("user", u.path, c, u.email) } as Column<{ path: string; email: string }>)),
  ];

  // Rules as JSON: the reviewable, diffable, restorable form of the whole access configuration. Export is a
  // plain download of every rule in its create-body shape; import replays those bodies through the SAME API
  // (and therefore the same validation, four-eyes queue and audit trail) - never a direct row write.
  function exportRules() {
    const payload = { exported_at: new Date().toISOString(), rules: rules.filter((r) => r.subject_kind === subjectKind).map(ruleBody) };
    saveBytes(JSON.stringify(payload, null, 2), `access-rules-${subjectKind}s-${todayStr()}.json`, "application/json");
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

  /**
   * Apply a starter pack to a role - the same replay the JSON import does, over a curated bundle instead of
   * a file. Every rule goes through `POST /v1/access-rules`, so a template cannot author anything an admin
   * could not have written by hand, and it lands in the four-eyes queue and the audit trail like any other
   * change. Additive: rules that already exist come back as 409 and are counted as skipped, so applying a
   * template twice is safe and applying one over an existing role only fills gaps.
   */
  async function applyTemplate(kind: Kind, subject: string, key: string) {
    const t = ROLE_TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    const who = kind === "role" ? roleLabel(subject) : (users.find((u) => u.path === subject)?.email ?? "this person");
    const ok = await confirm({
      title: `Apply "${t.label}" to ${who}?`,
      description: `${templateSize(t)} rules are added: ${t.summary} Nothing is removed, and rules already there are kept - review them afterwards before relying on it.`,
      confirmLabel: "Apply",
    });
    if (!ok) return;
    setBusy(true);
    let added = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const r of t.rules) {
      try {
        await create("access-rules", templateRuleBody(kind, subject, r));
        added++;
      } catch (e) {
        const msg = String((e as Error).message);
        if (msg.toLowerCase().includes("already exists")) skipped++;
        else failed.push(msg);
      }
    }
    setTemplate(null);
    toast({
      title: `Added ${added} rules to ${who}`,
      description: `${skipped} already there${failed.length ? ` · ${failed.length} rejected: ${failed[0]}` : ""}`,
      variant: failed.length ? "destructive" : "success",
    });
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
      {canManage && (subjectKind === "role" ? roles.length > 0 : users.length > 0) && (
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          onClick={() => setTemplate({ kind: subjectKind, subject: (subjectKind === "role" ? roles[0]?.name : users[0]?.path) ?? "", key: ROLE_TEMPLATES[0]!.key })}
          title={subjectKind === "role"
            ? "Give a role a least-privilege starting point instead of building it rule by rule"
            : "Give one person a second job's access without inventing a role for it"}
        >
          <Sparkles className="h-3.5 w-3.5" /> Start from a template
        </Button>
      )}
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

  // Starter packs. A new role is deny-all by design, so the choice this dialog offers is the JOB, not the
  // rules: pick who this person is and get a least-privilege bundle to review, instead of an empty grid and
  // sixty decisions. The rules are listed before applying, because a template an admin cannot read is a
  // template they cannot be responsible for.
  const templateDialog = template && (
    <Dialog open onOpenChange={(o) => !o && setTemplate(null)}>
      {/* `sm:` on the height ceiling: unprefixed it overrides the phone bottom-sheet geometry in ui/dialog.tsx,
          which insets the panel and gives up height to the on-screen keyboard - so the footer ends up behind the
          keys. `max-w-2xl` needs no prefix; the sheet's own inset already bounds the width on a phone. */}
      <DialogContent className="sm:max-h-[85dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" /> Start from a template
          </DialogTitle>
          <DialogDescription>
            Adds a least-privilege set of rules. Nothing is removed, and every rule is authored through the
            normal path - so it is validated, audited, and waits for a second approver if four-eyes is on.
            Applied to a PERSON it is how somebody takes on a second job's access without inventing a role for
            it (their copy will not follow the template if the template later changes).
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label className="mb-1 block text-xs font-medium">{template.kind === "role" ? "Role" : "Person"}</label>
            <Select value={template.subject} onValueChange={(v) => setTemplate({ ...template, subject: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {template.kind === "role"
                  ? roles.map((r) => <SelectItem key={r.name} value={r.name}>{roleLabel(r.name)}</SelectItem>)
                  : users.map((u) => <SelectItem key={u.path} value={u.path}>{u.email}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-48 flex-1">
            <label className="mb-1 block text-xs font-medium">Template</label>
            <Select value={template.key} onValueChange={(v) => setTemplate({ ...template, key: v })}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLE_TEMPLATES.map((t) => <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button disabled={busy || !template.subject} onClick={() => void applyTemplate(template.kind, template.subject, template.key)}>Apply</Button>
        </div>
        {(() => {
          const t = ROLE_TEMPLATES.find((x) => x.key === template.key);
          if (!t) return null;
          return (
            <>
              <p className="text-sm text-muted-foreground">{t.summary}</p>
              <p className="text-xs font-medium">{templateSize(t)} rules</p>
              <ul className="space-y-0.5 rounded-lg border p-3 text-xs">
                {t.rules.map((r, i) => (
                  <li key={i} className={r.effect === "deny" ? "text-destructive" : "text-muted-foreground"}>
                    {r.effect === "deny" ? "deny " : ""}
                    {r.verb ? `"${r.verb}" on ` : r.scope === "create" && r.level === "read" ? "open the list of " : r.scope === "create" ? "create " : `${r.level ?? "read"} `}
                    {labelOf(r.collection)}
                    {r.field ? ` (${r.field})` : ""}
                    {/* WHOSE rows, for every subject-relative tier - the manager chain included. Without the
                        last two a `my-reports` rule read exactly like an org-wide one in this list. */}
                    {r.scope === "dept" ? " - their department's"
                      : r.scope === "self" ? " - their own"
                      : r.scope === "reports" ? " - their reports'"
                      : r.scope === "org" ? " - their reporting line's"
                      : ""}
                  </li>
                ))}
              </ul>
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
  // `review !== null` counts too: the card now hosts BOTH lifecycle switches, so a workspace that can read
  // the review setting but not the approval one would otherwise lose the whole card and with it the toggle.
  const pendingCard = (pending.length > 0 || fourEyes !== null || review !== null) && (
    <Card className="mb-3">
      <CardContent className="space-y-2 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">Permission changes</p>
            <p className="text-xs text-muted-foreground">
              {fourEyes ? "Every change waits for a different access admin to approve it." : "Changes apply immediately. Turn on four-eyes approval to require a second admin."}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            {fourEyes !== null && canWriteSettings && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={fourEyes} onCheckedChange={(v) => void setFourEyesEnabled(v === true)} /> Require a second approver
              </label>
            )}
            {review !== null && canWriteSettings && (
              <label className="flex items-center gap-2 text-sm" title="Every 90 days, remind the access admins to confirm or remove the permanent rules that grant write access or a custom method.">
                <Checkbox checked={review} onCheckedChange={(v) => void setReviewEnabled(v === true)} /> Review standing access quarterly
              </label>
            )}
          </div>
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
      {templateDialog}
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
          // Users x collections: a row per user, a column per collection. The walk stops at listAll's own page
          // ceiling, so `accessCollection` is passed for the residual case - the table then admits the window
          // rather than presenting whatever it holds as every login account.
          <div className="space-y-3">
            {matrixNote}
            <DataTable columns={userMatrixCols} rows={users} getRowId={(u) => u.path} tableId="user-perms-matrix" accessCollection="users" emptyTitle="No users" controlsSlot={controlsSlot} />
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
            {/* The same reasoning as `reload`'s two stages, one step earlier. The collection list needs no
                server answer at all, so the matrix can paint its rows before the ROLES have landed - and a
                grid with a Collection column and no role columns beside it does not read as "still loading"
                either, it reads as "this org has no roles". Say which it is instead of drawing the table. */}
            {roles.length === 0 ? (
              <p className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">
                {busy ? "Loading roles…" : "No roles to show."}
              </p>
            ) : (
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
            )}
          </div>
        )}
      </CardContent>
      </Card>
    </>
  );
}
