import * as React from "react";
import { Trash2, Plus, AlertTriangle, Clock } from "lucide-react";
import { create, remove } from "@/api";
import { roleLabel } from "@/lib/roles";
import { customMethodsFor } from "./customMethods";
import { type AccessRule, BASE_COLLECTIONS, collectionsForRules, labelOf, scopesForCollection, fetchScopeCapabilities, scopeText, permText } from "./permMatrix";
import { ruleSentence, ruleFlags } from "./ruleLogic";
// The server's own set, imported rather than restated: it is what `isFieldScopeTarget` validates against, so a
// picker built from anything else would offer rules the validator refuses (which is exactly what happened).
import { COLLECTION_FIELD_CAPABILITIES } from "../../../../src/domain/manifests";
import { DataTable, type Column } from "@/components/common/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { useConfirm } from "@/components/common/confirm";

// A Select item can never carry an empty value (Radix reserves "" for "cleared"), so the "any collection"
// choice in activity's target picker travels under a sentinel and maps back to "" on the rule.
const ANY_COLLECTION = "__any__";

type RoleOption = { name: string; label: string };
type UserOption = { path: string; email: string };

// Lists EVERY assigned rule (any scope/field/verb) for a subject (fixedSubject) or across roles/users
// (roleOptions/userOptions), on the shared DataTable (so it gets the same per-column filters/sorting as
// everywhere), with delete + an add form. Object-scoped (exact) rules are authored via the in-context
// manage-access icons (which know the object), so the add form offers all/own/department only.
export function FineRulesEditor({
  rules,
  reload,
  fixedSubject,
  roleOptions,
  userOptions,
  canWrite,
  controlsSlot,
}: {
  rules: AccessRule[];
  reload: () => Promise<void> | void;
  fixedSubject?: { kind: "role" | "user"; subject: string };
  roleOptions?: RoleOption[];
  userOptions?: UserOption[];
  canWrite: boolean;
  controlsSlot?: HTMLElement | null;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState(false);
  // Per-collection grantable scope tiers from the policy manifest (carried on users/me, cached in permMatrix).
  // The add form is object-less, so it offers the subject-relative tiers only (self/dept/all) - the
  // object-anchored exact/subtree are authored from the in-context manage-access icons that know the object.
  const [scopeCaps, setScopeCaps] = React.useState<Record<string, string[]>>({});
  React.useEffect(() => {
    fetchScopeCapabilities().then(setScopeCaps).catch(() => setScopeCaps({}));
  }, []);

  const multi = !fixedSubject;
  const hasRoles = !!roleOptions?.length;
  const hasUsers = !!userOptions?.length;
  const emailMap = React.useMemo(() => new Map((userOptions ?? []).map((u) => [u.path, u.email])), [userOptions]);
  const subjLabel = (r: AccessRule) => (r.subject_kind === "role" ? roleLabel(r.subject) : emailMap.get(r.subject) ?? r.subject.split("/").pop() ?? r.subject);

  const allCollections = collectionsForRules(rules).length ? collectionsForRules(rules) : BASE_COLLECTIONS;
  const [add, setAdd] = React.useState({
    subjectKind: (roleOptions ? "role" : "user") as "role" | "user",
    subject: roleOptions?.[0]?.name ?? userOptions?.[0]?.path ?? "",
    collection: allCollections[0] ?? "employees",
    scope: "all",
    field: "",
    kind: "level", // "level" | "verb"
    level: "read",
    verb: "",
    effect: "allow",
    expires: "", // optional expiry (temporary access); "" = permanent
  });
  const verbs = customMethodsFor(add.collection);
  // The relevant subject-relative scopes for the selected collection (object-less form -> hasObject=false).
  const scopeOpts = scopesForCollection(add.collection, false, scopeCaps);
  const addSubjectOptions: [string, string][] = add.subjectKind === "role" ? (roleOptions ?? []).map((r) => [r.name, r.label]) : (userOptions ?? []).map((u) => [u.path, u.email]);

  async function del(r: AccessRule) {
    if (!(await confirm({ title: "Remove this permission rule?", destructive: true, confirmLabel: "Remove" }))) return;
    setBusy(true);
    try {
      await remove(r.path, r.etag);
      toast({ title: "Rule removed" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not remove", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  async function addRule() {
    const subjectKind = fixedSubject?.kind ?? add.subjectKind;
    const subject = fixedSubject?.subject ?? add.subject;
    if (!subject) return;
    setBusy(true);
    try {
      const perm = add.kind === "verb" ? { verb: add.verb || verbs[0], effect: add.effect } : add.effect === "deny" ? { effect: "deny" } : { level: add.level };
      await create("access-rules", {
        subject_kind: subjectKind,
        subject,
        collection: add.collection,
        scope: add.scope,
        ...(add.field.trim() ? { field: add.field.trim() } : {}),
        ...perm,
        ...(add.expires && add.effect !== "deny" ? { expire_time: new Date(`${add.expires}T23:59:59`).toISOString() } : {}),
      });
      toast({ title: "Rule added" });
      await reload();
    } catch (e) {
      toast({ variant: "destructive", title: "Could not add rule", description: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<AccessRule>[] = [
    ...(multi ? [{ id: "subject", header: "Subject", filter: "select", accessor: (r: AccessRule) => subjLabel(r) } as Column<AccessRule>] : []),
    // The rule AS A SENTENCE, first and widest: five coded columns (collection/scope/field/permission/effect)
    // made every row a decoding exercise. The coded columns stay for filtering and sorting.
    {
      id: "rule",
      header: "Rule",
      filter: "text",
      accessor: (r) => ruleSentence(r, subjLabel(r)),
      cell: (r) => {
        // Dead-rule lint: a rule beaten by a deny, or already covered by a broader one, looks exactly like a
        // working rule in the table. Flagging it is the difference between "access is configured" and
        // "access works".
        const flags = ruleFlags(r, rules);
        const bad = flags.find((f) => f.kind === "denied" || f.kind === "shadowed");
        // NOT struck through, unlike the two above: this rule is live and correct for every individual record,
        // it just has no page to show them on. "Incomplete", not "dead" - striking it out would send an admin
        // to delete the rule when the fix is to add one.
        const partial = !bad && flags.find((f) => f.kind === "unlistable");
        const life = flags.find((f) => f.kind === "pending" || f.kind === "expiring");
        return (
          <div className="min-w-64 space-y-0.5">
            <span className={bad ? "text-muted-foreground line-through decoration-muted-foreground/40" : undefined}>{ruleSentence(r, subjLabel(r))}</span>
            {bad && (
              <span className="flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400" title={bad.note}>
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" /> {bad.kind === "denied" ? "no effect - a deny overrides this" : "no effect - already covered by a broader rule"}
              </span>
            )}
            {partial && (
              <span className="flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-400" title={partial.note}>
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" /> cannot open the list - pair with read on the collection
              </span>
            )}
            {life && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground" title={life.note}>
                <Clock className="h-3 w-3 shrink-0" /> {life.note}
              </span>
            )}
          </div>
        );
      },
    },
    { id: "collection", header: "Collection", filter: "select", accessor: (r) => labelOf(r.collection), cell: (r) => <span className="font-medium">{labelOf(r.collection)}</span> },
    { id: "scope", header: "Scope", filter: "select", accessor: (r) => scopeText(r) },
    { id: "field", header: "Field", filter: "select", accessor: (r) => r.field ?? "-" },
    { id: "perm", header: "Permission", filter: "select", accessor: (r) => permText(r), cell: (r) => <Badge variant={r.effect === "deny" ? "destructive" : r.verb ? "default" : "secondary"}>{permText(r)}</Badge> },
    { id: "state", header: "State", filter: "select", accessor: (r) => (r.status && r.status !== "active" ? "awaiting approval" : r.expire_time ? "temporary" : "live") },
    ...(canWrite
      ? [{ id: "actions", header: "", sortable: false, filter: "none", align: "right", cell: (r: AccessRule) => <Button variant="ghost" size="icon" aria-label="Delete this rule" className="h-8 w-8" disabled={busy} onClick={() => del(r)}><Trash2 className="h-4 w-4" /></Button> } as Column<AccessRule>]
      : []),
  ];

  return (
    <div className="space-y-3">
      <DataTable
        columns={columns}
        rows={rules}
        getRowId={(r) => r.path}
        tableId={`fine-rules-${fixedSubject ? fixedSubject.kind : "all"}`}
        emptyTitle="No rules"
        emptyDescription="No permission rules assigned."
        controlsSlot={controlsSlot}
      />

      {canWrite && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-muted/20 p-3">
          {multi && hasRoles && hasUsers && (
            <Picker label="Subject kind" value={add.subjectKind} onChange={(v) => setAdd({ ...add, subjectKind: v as "role" | "user", subject: (v === "role" ? roleOptions?.[0]?.name : userOptions?.[0]?.path) ?? "" })} options={[["role", "Role"], ["user", "User"]]} />
          )}
          {multi && <Picker label={add.subjectKind === "role" ? "Role" : "User"} value={add.subject} onChange={(v) => setAdd({ ...add, subject: v })} options={addSubjectOptions} wide />}
          <Picker
            label="Collection"
            value={add.collection}
            onChange={(v) => {
              // Keep the chosen scope valid for the new collection (else snap to its narrowest), so switching
              // collection never leaves an inert scope selected.
              const opts = scopesForCollection(v, false, scopeCaps);
              const scope = opts.some((o) => o.value === add.scope) ? add.scope : opts[0]?.value ?? "all";
              setAdd({ ...add, collection: v, scope, kind: "level", verb: "" });
            }}
            options={allCollections.map((c) => [c, labelOf(c)])}
          />
          <Picker label="Scope" value={add.scope} onChange={(v) => setAdd({ ...add, scope: v })} options={scopeOpts.map((s) => [s.value, s.label])} />
          {COLLECTION_FIELD_CAPABILITIES.has(add.collection) ? (
            // For these capabilities the "field" slot is the TARGET collection: empty = every collection, else
            // narrow to one (`activity.<scope>.<collection>`, `export.<scope>.<collection>`). Driven by the
            // server's own set rather than a name test here, so the picker and the validator that accepts what
            // it writes can never disagree about which capabilities work this way.
            <Picker label="For collection" value={add.field || ANY_COLLECTION} onChange={(v) => setAdd({ ...add, field: v === ANY_COLLECTION ? "" : v })} options={[[ANY_COLLECTION, "All collections"], ...BASE_COLLECTIONS.filter((c) => !COLLECTION_FIELD_CAPABILITIES.has(c)).map((c) => [c, labelOf(c)] as [string, string])]} wide />
          ) : (
            <div className="w-24">
              <label className="mb-1 block text-xs font-medium">Field</label>
              <Input className="h-9" value={add.field} placeholder="(optional)" onChange={(e) => setAdd({ ...add, field: e.target.value })} />
            </div>
          )}
          <Picker label="Type" value={add.kind} onChange={(v) => setAdd({ ...add, kind: v })} options={verbs.length ? [["level", "Level"], ["verb", "Custom method"]] : [["level", "Level"]]} />
          {add.kind === "verb" ? (
            <Picker label="Method" value={add.verb || verbs[0] || ""} onChange={(v) => setAdd({ ...add, verb: v })} options={verbs.map((v) => [v, v])} />
          ) : (
            <Picker label="Level" value={add.level} onChange={(v) => setAdd({ ...add, level: v })} options={[["read", "read"], ["write", "write"], ["admin", "admin"]]} />
          )}
          <Picker label="Effect" value={add.effect} onChange={(v) => setAdd({ ...add, effect: v })} options={[["allow", "allow"], ["deny", "deny"]]} />
          {add.effect !== "deny" && (
            // Temporary access (contractor, cover during leave): the rule revokes itself at the end of that
            // day instead of relying on someone remembering.
            <div className="w-36">
              <label className="mb-1 block text-xs font-medium" title="Leave empty for permanent access.">Expires</label>
              <Input type="date" className="h-9" value={add.expires} min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} onChange={(e) => setAdd({ ...add, expires: e.target.value })} />
            </div>
          )}
          <Button disabled={busy || (multi && !add.subject) || (add.kind === "verb" && !(add.verb || verbs[0]))} onClick={addRule}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      )}
    </div>
  );
}

function Picker({ label, value, onChange, options, wide }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][]; wide?: boolean }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className={wide ? "h-9 w-48" : "h-9 w-36"}><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
